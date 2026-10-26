#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DeepSeek 网页版本机中转（只跑在自己电脑上）
============================================================================
为什么需要它：浏览器里的网页不能直接请求 chat.deepseek.com —— 跨域被拦，
而且每次对话都要带一个 PoW 挑战头（要用官方 wasm 现算）。这个脚本替网页做
这两件事，然后以 OpenAI 的格式把结果流式吐回浏览器。

启动：
    python3 tools/dsweb-relay.py                # 默认 127.0.0.1:8790
    python3 tools/dsweb-relay.py --port 8791

接口（都带 CORS，允许网页直接调用）：
    GET  /health                    本机环境自检（node / solver / wasm）
    POST /v1/probe                  用请求里的凭据问一句「我是谁」，验证 token
    POST /v1/chat/completions       兼容 OpenAI：messages / stream / model

凭据怎么给：网页端把 chat.deepseek.com 的 curl 粘进去，解析出 userToken 和
cookie 后，随每个请求放在 Authorization / X-DS-Cookie 头里传过来。脚本自己不
存任何凭据，也不上传任何数据到别处。

支持的模型名：
    deepseek         普通对话
    deepseek-think   深度思考（R1 式推理）
    deepseek-search  联网搜索
    deepseek-think-search  两者都开

图片：messages 里的 image_url（data URL 或 http 地址）会先传到 DeepSeek 的
文件接口，再以 ref_file_ids 带进对话 —— 手写作业拍照批改就是走这条路。
============================================================================
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = "https://chat.deepseek.com"
ROOT = os.path.dirname(os.path.abspath(__file__))
POW_DIR = os.path.join(ROOT, "dsweb")
SOLVER = os.path.join(POW_DIR, "solver.js")
WASM = os.path.join(POW_DIR, "sha3_wasm_bg.wasm")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0")

MODES = {
    # 网页端默认开着联网搜索和深度思考，所以 deepseek 这个名字就是两者全开
    "deepseek": (True, True),
    "deepseek-think": (True, False),
    "deepseek-r1": (True, False),
    "deepseek-search": (False, True),
    "deepseek-think-search": (True, True),
}

MAX_IMAGE_BYTES = 8 * 1024 * 1024


class DSError(RuntimeError):
    def __init__(self, message, code="upstream", status=502):
        super().__init__(message)
        self.code = code
        self.status = status


# --------------------------------------------------------------------- node 探测

_node_cache = {"path": None, "checked_at": 0.0}
_node_lock = threading.Lock()
NODE_RETRY_SEC = 30


def _probe_node():
    cands = [shutil.which("node"), shutil.which("nodejs"),
             "/opt/homebrew/bin/node", "/usr/local/bin/node"]
    home = os.path.expanduser("~")
    base = os.path.join(home, ".workbuddy", "binaries", "node", "versions")
    if os.path.isdir(base):
        for v in sorted(os.listdir(base), reverse=True):
            cands.append(os.path.join(base, v, "bin", "node"))
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            try:
                r = subprocess.run([c, "-e", "console.log('ok')"],
                                   capture_output=True, text=True, timeout=15)
                if r.returncode == 0 and "ok" in r.stdout:
                    return c
            except Exception:
                continue
    return None


def find_node():
    path = _node_cache["path"]
    if path and os.path.isfile(path) and os.access(path, os.X_OK):
        return path
    with _node_lock:
        path = _node_cache["path"]
        if path:
            if os.path.isfile(path) and os.access(path, os.X_OK):
                return path
            _node_cache["path"] = None
            _node_cache["checked_at"] = 0.0
        if _node_cache["checked_at"] and (time.time() - _node_cache["checked_at"]) < NODE_RETRY_SEC:
            return None
        _node_cache["path"] = _probe_node()
        _node_cache["checked_at"] = time.time()
        return _node_cache["path"]


def env_status():
    return {
        "node": find_node(),
        "solver": os.path.isfile(SOLVER),
        "wasm": os.path.isfile(WASM),
    }


# --------------------------------------------------------------------- 客户端

class DSClient:
    def __init__(self, token, cookie="", timeout=180, extra=None):
        self.token = (token or "").strip()
        self.cookie = (cookie or "").strip()
        self.timeout = timeout
        # 浏览器那条 curl 里的 x-device-id / x-hif-* / UA 等，原样重放
        self.extra = dict(extra or {})
        if not self.token:
            raise DSError("没有登录凭据：先复制一条 chat.deepseek.com 的 curl 贴到网页里",
                          code="token_missing", status=401)

    def headers(self, extra=None):
        h = {
            "authorization": "Bearer " + self.token,
            "User-Agent": UA,
            "Content-Type": "application/json",
            "accept": "*/*",
            "origin": BASE,
            "referer": BASE + "/",
            "x-client-platform": "web",
            "x-client-version": "2.7.0",
            "x-client-locale": "zh_CN",
            "x-client-bundle-id": "com.deepseek.chat",
            "x-client-timezone-offset": "28800",
        }
        if self.cookie:
            h["Cookie"] = self.cookie
        for k, v in self.extra.items():
            if k in ("content-type", "cookie", "authorization", "host",
                     "content-length", "accept-encoding", "connection"):
                continue
            h[k] = v
        h.update(extra or {})
        return h

    def post(self, path, body, extra=None, stream=False, timeout=None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(BASE + path, data=data,
                                     headers=self.headers(extra), method="POST")
        try:
            resp = urllib.request.urlopen(req, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            raise DSError("DeepSeek 返回 HTTP %d：%s" % (e.code, detail),
                          code="token_invalid" if e.code in (401, 403) else "upstream",
                          status=401 if e.code in (401, 403) else 502)
        except urllib.error.URLError as e:
            raise DSError("连不上 chat.deepseek.com（%s），检查网络或代理" % e.reason,
                          code="network", status=502)
        if stream:
            return resp
        with resp:
            return json.loads(resp.read().decode("utf-8", "replace"))

    def biz(self, path, body, extra=None):
        r = self.post(path, body, extra)
        if r.get("code") != 0:
            code = r.get("code")
            msg = r.get("msg") or ""
            if code in (40001, 40003, 40100) or "TOKEN" in str(msg).upper() or "AUTH" in str(msg).upper():
                raise DSError("登录凭据失效了（%s %s），重新复制一条 curl 贴上" % (code, msg),
                              code="token_invalid", status=401)
            raise DSError("DeepSeek 接口 %s 报错：code=%s msg=%s" % (path, code, msg))
        return (r.get("data") or {}).get("biz_data") or {}

    # ---- PoW
    def _solve(self, ch):
        node = find_node()
        if not node:
            raise DSError("没找到可用的 node，PoW 解不了；装个 Node.js 再启动本服务",
                          code="node_missing", status=503)
        if not (os.path.isfile(SOLVER) and os.path.isfile(WASM)):
            raise DSError("缺少 tools/dsweb/solver.js 或 sha3_wasm_bg.wasm",
                          code="solver_missing", status=503)
        payload = json.dumps({
            "algorithm": ch.get("algorithm", "DeepSeekHashV1"),
            "challenge": ch.get("challenge"), "salt": ch.get("salt"),
            "difficulty": ch.get("difficulty"), "expire_at": ch.get("expire_at"),
        })
        try:
            r = subprocess.run([node, SOLVER, payload], capture_output=True,
                               text=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise DSError("PoW 求解超时", code="pow_timeout", status=504)
        if r.returncode != 0 or not r.stdout.strip():
            raise DSError("PoW 求解失败：" + (r.stderr or "")[:200], code="pow_failed", status=502)
        return int(r.stdout.strip())

    def pow_for(self, target="/api/v0/chat/completion"):
        biz = self.biz("/api/v0/chat/create_pow_challenge", {"target_path": target})
        ch = biz.get("challenge") or biz
        ans = self._solve(ch)
        obj = {
            "algorithm": ch.get("algorithm", "DeepSeekHashV1"),
            "challenge": ch["challenge"], "salt": ch["salt"], "answer": ans,
            "signature": ch["signature"],
            "target_path": ch.get("target_path") or target,
        }
        return base64.b64encode(
            json.dumps(obj, separators=(",", ":")).encode()).decode()

    # ---- 会话
    def new_session(self):
        b = self.biz("/api/v0/chat_session/create",
                     {"target_path": "/api/v0/chat/completion"})
        cs = b.get("chat_session") or b
        return cs["id"]

    # ---- 文件（图片）
    def upload(self, raw, name, mime):
        if len(raw) > MAX_IMAGE_BYTES:
            raise DSError("图片太大了（%.1f MB），压缩到 8MB 以内再传" % (len(raw) / 1048576.0),
                          code="image_too_large", status=413)
        boundary = "----dsweb" + uuid.uuid4().hex
        head = ('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\n'
                'Content-Type: %s\r\n\r\n' % (boundary, name, mime)).encode("utf-8")
        body = head + raw + ("\r\n--%s--\r\n" % boundary).encode("utf-8")
        h = self.headers({
            "Content-Type": "multipart/form-data; boundary=" + boundary,
            "x-ds-pow-response": self.pow_for("/api/v0/file/upload_file"),
        })
        req = urllib.request.Request(BASE + "/api/v0/file/upload_file",
                                     data=body, headers=h, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                j = json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            raise DSError("图片上传失败：HTTP %d %s" % (
                e.code, e.read().decode("utf-8", "replace")[:200]), code="upload_failed")
        if j.get("code") != 0:
            raise DSError("图片上传被拒：code=%s msg=%s" % (j.get("code"), j.get("msg")),
                          code="upload_failed")
        fid = ((j.get("data") or {}).get("biz_data") or {}).get("id")
        if not fid:
            raise DSError("图片上传没有拿到文件 id", code="upload_failed")
        return fid

    # ---- 对话
    def stream(self, prompt, file_ids=None, thinking=False, search=False):
        sid = self.new_session()
        hdr = self.pow_for()
        body = {
            "chat_session_id": sid, "parent_message_id": None,
            "model_type": "default", "prompt": prompt,
            "ref_file_ids": list(file_ids or []),
            "thinking_enabled": bool(thinking), "search_enabled": bool(search),
            "preempt": False,
        }
        resp = self.post("/api/v0/chat/completion", body, extra={
            "x-ds-pow-response": hdr,
            "referer": BASE + "/a/chat/s/" + sid,
            "accept": "text/event-stream",
        }, stream=True, timeout=self.timeout)
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if "event-stream" not in ctype:
            head = b""
            try:
                head = resp.read(300)
            except Exception:
                pass
            finally:
                try:
                    resp.close()
                except Exception:
                    pass
            snippet = head.decode("utf-8", "replace").strip()[:160]
            raise DSError("DeepSeek 没有返回流（HTTP %s · %s）。%s" % (
                resp.status, ctype or "空", ("开头：" + snippet) if snippet else ""),
                code="no_stream")
        yield from self._parse(resp)

    @staticmethod
    def _patch(p, o, v, out):
        if o == "APPEND" and isinstance(p, str) and p.endswith("/content"):
            kind = "reasoning" if "thinking" in p.lower() else "text"
            if v:
                out.append((kind, v))
        elif o == "BATCH" and isinstance(v, list):
            for item in v:
                if isinstance(item, dict) and "p" in item:
                    DSClient._patch(item.get("p"), item.get("o", "APPEND"),
                                    item.get("v"), out)

    def _parse(self, resp):
        buf = ""
        cur = "text"
        for raw in resp:
            buf += raw.decode("utf-8", "replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    j = json.loads(payload)
                except Exception:
                    continue
                if not isinstance(j, dict) or "v" not in j:
                    continue
                v, p, o = j["v"], j.get("p"), j.get("o")
                if p is None and o is None and isinstance(v, dict):
                    obj = v.get("response") or v
                    for f in (obj.get("fragments") or []):
                        t = f.get("content") or ""
                        if t:
                            kind = "reasoning" if f.get("type") == "THINKING" else "text"
                            if kind == "reasoning":
                                cur = "reasoning"
                            yield (kind, t)
                    continue
                if p is None and o is None and isinstance(v, str):
                    if v:
                        yield (cur, v)
                    continue
                if isinstance(p, str):
                    cur = "reasoning" if "thinking" in p.lower() else "text"
                out = []
                self._patch(p, o, v, out)
                for item in out:
                    yield item
                if o == "SET" and p == "response/status":
                    if v == "FINISHED":
                        return
                    if v in ("FAILED", "CONTENT_FILTER", "BANNED"):
                        raise DSError("这条内容被 DeepSeek 拒了（%s），换个说法再试" % v,
                                      code="filtered")


# --------------------------------------------------------------------- 工具

def flatten(messages):
    """把 OpenAI 的 messages 拍平成单轮 prompt，顺便收集图片。"""
    parts, images = [], []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        c = m.get("content")
        if isinstance(c, str):
            text = c
        else:
            segs = []
            for p in (c or []):
                if not isinstance(p, dict):
                    continue
                t = p.get("type")
                if t in ("text", "input_text"):
                    segs.append(p.get("text") or "")
                elif t in ("image_url", "input_image"):
                    u = p.get("image_url")
                    if isinstance(u, dict):
                        u = u.get("url")
                    if u:
                        images.append(u)
            text = "\n".join(segs)
        text = (text or "").strip()
        if not text and not images:
            continue
        if role == "system":
            parts.append("【要求】\n" + text)
        elif role == "assistant":
            parts.append("【之前的回答】\n" + text)
        else:
            parts.append(text)
    return "\n\n".join(p for p in parts if p), images


def decode_image(u):
    u = str(u or "")
    m = re.match(r"^data:([^;,]+)?(;base64)?,(.*)$", u, re.S)
    if m:
        mime = m.group(1) or "image/jpeg"
        data = m.group(3)
        if m.group(2):
            raw = base64.b64decode(data + "=" * (-len(data) % 4))
        else:
            raw = urllib.parse.unquote_to_bytes(data)
        ext = mimetypes.guess_extension(mime) or ".jpg"
        return raw, mime, "photo" + ext
    if u.startswith("http"):
        with urllib.request.urlopen(u, timeout=60) as r:
            raw = r.read()
            mime = r.headers.get("Content-Type") or "image/jpeg"
        ext = mimetypes.guess_extension(mime.split(";")[0]) or ".jpg"
        return raw, mime, "photo" + ext
    raise DSError("图片地址看不懂，只能是 data: 或 http(s):", code="bad_image", status=400)


def sse(obj):
    return ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8")


# --------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "dsweb-relay/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    # ---- 基础
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "content-type, authorization, x-ds-cookie, x-ds-ua, x-ds-headers")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send(self, code, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def _err(self, code, err_code, msg):
        self._send(code, {"error": {"message": msg, "code": err_code}})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8", "replace") or "{}")
        except Exception:
            return {}

    def _token(self):
        auth = self.headers.get("Authorization") or ""
        tok = auth[7:].strip() if auth.lower().startswith("bearer ") else auth.strip()
        if not tok:
            tok = (os.environ.get("DS_TOKEN") or "").strip()
        cookie = (self.headers.get("X-DS-Cookie") or os.environ.get("DS_COOKIE") or "").strip()
        return tok, cookie

    def _extra_headers(self):
        """网页把 curl 里的整套头 base64 JSON 塞在 X-DS-Headers 里，这里解出来。"""
        raw = (self.headers.get("X-DS-Headers") or "").strip()
        if not raw:
            return {}
        try:
            pad = "=" * (-len(raw) % 4)
            obj = json.loads(base64.b64decode(raw + pad).decode("utf-8", "replace"))
            if isinstance(obj, dict):
                return {str(k).lower(): str(v) for k, v in obj.items() if v}
        except Exception:
            pass
        return {}

    # ---- 路由
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/health", "/"):
            st = env_status()
            self._send(200, {"ok": bool(st["node"] and st["solver"] and st["wasm"]),
                             "service": "dsweb-relay", "version": 1,
                             "base": BASE, "env": st})
            return
        self._err(404, "not_found", "没有这个接口")

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/v1/probe":
                self._probe()
            elif path in ("/v1/chat/completions", "/chat/completions"):
                self._chat()
            else:
                self._err(404, "not_found", "没有这个接口")
        except DSError as e:
            self._err(e.status, e.code, str(e))
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa
            traceback.print_exc()
            self._err(500, "internal", "%s: %s" % (type(e).__name__, e))

    # ---- 具体接口
    def _probe(self):
        token, cookie = self._token()
        st = env_status()
        if not token:
            self._send(200, {"ok": False, "env": st, "code": "token_missing",
                             "message": "还没贴凭据"})
            return
        c = DSClient(token, cookie, timeout=20, extra=self._extra_headers())
        req = urllib.request.Request(BASE + "/api/v0/users/current",
                                     headers=c.headers(), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            self._send(200, {"ok": False, "env": st, "code": "token_invalid",
                             "message": "HTTP %d" % e.code})
            return
        except Exception as e:
            self._send(200, {"ok": False, "env": st, "code": "network",
                             "message": "%s" % e})
            return
        if j.get("code") != 0:
            self._send(200, {"ok": False, "env": st, "code": "token_invalid",
                             "message": "code=%s msg=%s" % (j.get("code"), j.get("msg"))})
            return
        b = (j.get("data") or {}).get("biz_data") or {}
        name = ((b.get("id_profile") or {}).get("name")) or b.get("email") or b.get("mobile_number") or ""
        self._send(200, {"ok": True, "env": st, "name": name, "user_id": b.get("id")})

    def _chat(self):
        body = self._body()
        token, cookie = self._token()
        model = str(body.get("model") or "deepseek")
        thinking, search = MODES.get(model, (False, False))
        prompt, images = flatten(body.get("messages"))
        if not prompt and not images:
            self._err(400, "empty", "消息是空的")
            return

        client = DSClient(token, cookie, timeout=300, extra=self._extra_headers())
        file_ids = []
        for u in images[:4]:
            raw, mime, name = decode_image(u)
            file_ids.append(client.upload(raw, name, mime))

        want_stream = body.get("stream", True) is not False
        cid = "chatcmpl-dsweb-" + uuid.uuid4().hex[:12]
        created = int(time.time())

        if not want_stream:
            buf = []
            for kind, text in client.stream(prompt, file_ids, thinking, search):
                if kind == "text":
                    buf.append(text)
            self._send(200, {
                "id": cid, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "".join(buf)}}],
            })
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.close_connection = True
        any_out = False
        try:
            for kind, text in client.stream(prompt, file_ids, thinking, search):
                if kind == "text":
                    any_out = True
                key = "reasoning_content" if kind == "reasoning" else "content"
                self.wfile.write(sse({
                    "id": cid, "object": "chat.completion.chunk", "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {key: text}, "finish_reason": None}],
                }))
                self.wfile.flush()
            if not any_out:
                self.wfile.write(sse({
                    "id": cid, "object": "chat.completion.chunk", "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": "stop"}],
                }))
                self.wfile.write(sse({"error": {"code": "empty", "message": "DeepSeek 这次一个字都没返回"}}))
        except DSError as e:
            self.wfile.write(sse({"error": {"code": e.code, "message": str(e)}}))
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa
            try:
                self.wfile.write(sse({"error": {"code": "internal", "message": str(e)}}))
            except Exception:
                pass
        finally:
            try:
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser(description="DeepSeek 网页版本机中转")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8790)
    args = ap.parse_args()

    st = env_status()
    print("DeepSeek 网页版中转已启动： http://%s:%d" % (args.host, args.port))
    print("  node  : %s" % (st["node"] or "未找到（PoW 需要 Node.js）"))
    print("  solver: %s" % ("ok" if st["solver"] else "缺少 tools/dsweb/solver.js"))
    print("  wasm  : %s" % ("ok" if st["wasm"] else "缺少 tools/dsweb/sha3_wasm_bg.wasm"))
    print("凭据不在这里配：网页里粘一条 chat.deepseek.com 的 curl 即可，随时可换。")
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
