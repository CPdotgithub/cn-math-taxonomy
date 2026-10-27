#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本站服务：静态页面 + 同站转发（/api/ds/*）

为什么要有这个文件
------------------
网页版（chat.deepseek.com）不给我们域名发 CORS 通行证，浏览器里直接 fetch 会被
拦掉（实测：响应里只有 access-control-allow-credentials，没有 allow-origin）。
所以必须有一个「同源」的转发点。参考「面试宝典」项目的做法：页面和转发放在同一个
服务里，前端 fetch('/api/ds/v1/chat/completions') 就是同源请求，不存在跨域问题，
手机上、别人电脑上打开都能用，不需要在自己电脑上再开一个 8790 中转。

跑法
----
    python3 server.py                 # 本地：自动挑 8899 等空闲端口，绑 127.0.0.1
    PORT=8080 python3 server.py       # 部署：绑 0.0.0.0 并监听 $PORT

转发实现复用 tools/dsweb-relay.py（PoW 求解、SSE、curl 头透传都在那边），
这里只负责：静态文件 + 把 /api/ds/xxx 路由过去。
"""

import os
import sys
import json
import time
import threading
import hashlib
import importlib.util
from http.server import ThreadingHTTPServer
from urllib.parse import unquote, urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
RELAY = os.path.join(ROOT, "tools", "dsweb-relay.py")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".pdf": "application/pdf",
}


# ---------------------------------------------------------------- AI 题的本地题库
# 浏览器 localStorage 会被清掉（清缓存、换设备、隐私模式），所以 AI 现出的题存一份到
# 服务端：页面照旧先用本地缓存（快），本地没有就问这里，再没有才去调模型。
STORE_PATH = os.path.join(ROOT, ".aiq-store.json")
# DeepSeek 网页版的登录凭据（一条 curl）。只对本机（127.0.0.1 / ::1）开放，
# 别把它当成公开接口——拿到 token 就等于拿到了账号。
CRED_PATH = os.path.join(ROOT, ".ds-cred.json")
CRED_LOCK = threading.Lock()

# 接口鉴权：和前端密码门同一个口令（前端算好 sha256 再发过来，不传明文）。
# 静态托管没有这一层；只有本服务在跑时才会要求。
GATE_HASH = os.environ.get("GATE_HASH") or "00847220aa587c230746ac58189197151d6322a13518104a476bdd96ac4b7ae8"  # 123456
# 本机放行默认关闭：线上有反代，所有请求的对端都是 127.0.0.1，靠 IP 判断等于不设防。
# 本地想省掉登录，启动时加 LOCAL_BYPASS=1。
LOCAL_BYPASS = os.environ.get("LOCAL_BYPASS") == "1"
SESS_PATH = os.path.join(ROOT, ".sessions.json")
SESS_LOCK = threading.Lock()
SESS_TTL = 30 * 24 * 3600


def _sessions():
    try:
        with open(SESS_PATH, "r", encoding="utf-8") as f:
            v = json.load(f)
        if isinstance(v, dict):
            now = time.time()
            return {k: t for k, t in v.items() if isinstance(t, (int, float)) and t > now}
    except Exception:
        pass
    return {}


def _save_sessions(d):
    tmp = SESS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f)
    os.replace(tmp, SESS_PATH)
    try:
        os.chmod(SESS_PATH, 0o600)
    except OSError:
        pass


def session_new():
    key = os.urandom(24).hex()
    with SESS_LOCK:
        d = _sessions()
        d[key] = time.time() + SESS_TTL
        _save_sessions(d)
    return key


def session_ok(key):
    if not key:
        return False
    with SESS_LOCK:
        d = _sessions()
        exp = d.get(key)
        return bool(exp and exp > time.time())
STORE_LOCK = threading.Lock()
STORE_PER_KEY = 5        # 同一个知识点最多留几个版本
STORE_TOTAL = 2000       # 总量上限，超了按时间淘汰最旧的


def _store_read():
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            v = json.load(f)
        if isinstance(v, dict) and isinstance(v.get("items"), dict):
            return v
    except Exception:
        pass
    return {"v": 1, "items": {}}


def _store_write(d):
    tmp = STORE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, STORE_PATH)


def store_get(key):
    if not key:
        return []
    with STORE_LOCK:
        return _store_read()["items"].get(key, [])


def store_put(key, q):
    """同一个 prompt 不重复存；新的放最前；每点 ≤5 版、总量 ≤2000。"""
    if not (key and isinstance(q, dict) and q.get("prompt")):
        return 0
    with STORE_LOCK:
        d = _store_read()
        items = d["items"]
        arr = [it for it in items.get(key, []) if it.get("q", {}).get("prompt") != q.get("prompt")]
        arr.insert(0, {"q": q, "at": int(time.time() * 1000)})
        items[key] = arr[:STORE_PER_KEY]
        flat = [(k, it) for k, lst in items.items() for it in lst]
        if len(flat) > STORE_TOTAL:
            flat.sort(key=lambda x: x[1].get("at") or 0)
            drop = set(id(it) for _, it in flat[:len(flat) - STORE_TOTAL])
            for k in list(items.keys()):
                items[k] = [it for it in items[k] if id(it) not in drop]
                if not items[k]:
                    del items[k]
        _store_write(d)
        return len(items.get(key, []))


def cred_read():
    try:
        with open(CRED_PATH, "r", encoding="utf-8") as f:
            v = json.load(f)
        if isinstance(v, dict) and v.get("token"):
            return v
    except Exception:
        pass
    return {}


def cred_write(d):
    tmp = CRED_PATH + ".tmp"
    with CRED_LOCK:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
        os.replace(tmp, CRED_PATH)
        try:
            os.chmod(CRED_PATH, 0o600)
        except OSError:
            pass


def load_relay():
    """把 tools/dsweb-relay.py 当模块加载（里面有 __main__ 守卫，import 不会起服务）。"""
    if not os.path.exists(RELAY):
        return None
    try:
        spec = importlib.util.spec_from_file_location("dsweb_relay", RELAY)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception as e:
        sys.stderr.write("[site] 转发模块加载失败：%s\n" % e)
        return None


def make_handler(relay):
    from http.server import BaseHTTPRequestHandler

    Base = relay.Handler if relay else BaseHTTPRequestHandler

    class Handler(Base):
        server_version = "cnm-site/1.0"

        # ---------- 静态文件 ----------
        def _local(self, path):
            rel = unquote(path).lstrip("/")
            # 点文件一律不对外：.ds-cred.json（登录凭据）、.sessions.json（会话）、
            # .aiq-store.json（题库缓存）都在站点根目录，绝不能当静态资源发出去
            if rel.startswith(".") or "/." in rel:
                return None
            full = os.path.normpath(os.path.join(ROOT, rel))
            if not (full == ROOT or full.startswith(ROOT + os.sep)):
                return None
            return full

        def _static(self, path, head_only=False):
            full = self._local(path or "/")
            if full is None:
                return self._plain(403, "forbidden")
            if os.path.isdir(full):
                full = os.path.join(full, "index.html")
            if not os.path.isfile(full):
                # 目录漏了结尾斜杠：/review → /review/
                alt = self._local(path.rstrip("/") + "/index.html")
                if alt and os.path.isfile(alt):
                    self.send_response(301)
                    self.send_header("Location", path.rstrip("/") + "/")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                return self._plain(404, "not found")

            ext = os.path.splitext(full)[1].lower()
            ctype = MIME.get(ext, "application/octet-stream")
            try:
                with open(full, "rb") as f:
                    data = f.read()
            except OSError:
                return self._plain(404, "not found")

            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            # sw.js / 页面不缓存，改了立刻生效；静态资源短缓存
            if ext in (".html", ".htm") or os.path.basename(full) in ("sw.js", "manifest.webmanifest"):
                self.send_header("Cache-Control", "no-cache")
            else:
                self.send_header("Cache-Control", "public, max-age=600")
            if ext in (".wasm",):
                self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
            self.end_headers()
            if not head_only:
                self.wfile.write(data)

        def _plain(self, code, text):
            body = (text + "\n").encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            if code >= 400:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(body)

        # ---------- 路由 ----------
        def _strip_api(self, path):
            """/api/ds/v1/chat/completions → /v1/chat/completions"""
            if path.startswith("/api/ds/"):
                return path[len("/api/ds"):]
            if path == "/api/ds":
                return "/"
            return None

        def do_GET(self, head_only=False):
            path = urlparse(self.path).path
            api = self._strip_api(path)
            if api is not None and relay:
                self.path = api
                return relay.Handler.do_GET(self)
            if path in ("/health",):
                return self._health()
            if path == "/api/q":
                if not self._authed():
                    return self._json({"ok": False, "code": "locked", "error": "需要先输入访问密码"}, 403)
                qs = parse_qs(urlparse(self.path).query)
                key = (qs.get("key") or [""])[0]
                return self._json({"ok": True, "items": store_get(key)})
            if path == "/api/cred":
                return self._api_cred_get()
            if path == "/api/session":
                return self._json({"ok": True, "authed": self._authed()})
            return self._static(path, head_only)

        def do_HEAD(self):
            return self.do_GET(head_only=True)

        def do_POST(self):
            path = urlparse(self.path).path
            api = self._strip_api(path)
            if api is not None and relay:
                self.path = api
                return relay.Handler.do_POST(self)
            if path == "/api/q":
                if not self._authed():
                    return self._json({"ok": False, "code": "locked", "error": "需要先输入访问密码"}, 403)
                return self._api_q_put()
            if path == "/api/cred":
                return self._api_cred_put()
            if path == "/api/unlock":
                return self._api_unlock()
            if path == "/api/cred" and (self.headers.get("X-Cnm-Method") or "").lower() == "delete":
                return self._api_cred_delete()
            return self._plain(404, "not found")

        def do_OPTIONS(self):
            path = urlparse(self.path).path
            if relay and (path.startswith("/api/ds/") or path == "/api/ds"):
                return relay.Handler.do_OPTIONS(self)
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self._cors_origin())
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type, x-cnm-key")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "86400")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _cors_origin(self):
            """PNA（公网页面访问本机）要求回显具体 Origin，通配 * 会被拒。"""
            return self.headers.get("Origin") or "*"

        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", self._cors_origin())
            self.send_header("Vary", "Origin")
            self.send_header("Cache-Control", "no-store")
            if code >= 400:
                # 拒绝时没人读请求 body，留在 socket 里会把下一个请求读成
                # 「Bad request syntax」——直接关连接，让客户端另开一条
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            self.wfile.write(body)

        def _api_q_put(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n > 0 else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                return self._json({"ok": False, "error": "bad json"}, 400)
            key = str(payload.get("key") or "")
            q = payload.get("q")
            if not key or not isinstance(q, dict) or not q.get("prompt") or q.get("answer") in (None, ""):
                return self._json({"ok": False, "error": "bad payload"}, 400)
            total = store_put(key, q)
            return self._json({"ok": True, "count": total})

        def _authed(self):
            """本机直接放行；其他来源要带上密码门换来的会话。"""
            if self._is_local():
                return True
            key = ""
            cookie = self.headers.get("Cookie") or ""
            for part in cookie.split(";"):
                k, _, v = part.strip().partition("=")
                if k == "cnmkey":
                    key = v
                    break
            if not key:
                key = (self.headers.get("X-Cnm-Key") or "").strip()
            return session_ok(key)

        def _api_unlock(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n > 0 else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                return self._json({"ok": False, "error": "bad json"}, 400)
            h = str(payload.get("h") or "").strip().lower()
            # 浏览器在非 https 的非 localhost 地址上拿不到 crypto.subtle，
            # 算不了哈希，就把明文发过来，这里帮着算（这段本来就是明文 http，不算额外泄露）
            if not h and payload.get("pass"):
                h = hashlib.sha256(("cnm-gate-v1:" + str(payload.get("pass"))).encode("utf-8")).hexdigest()
            if not h or h != GATE_HASH.lower():
                return self._json({"ok": False, "code": "bad_pass"}, 403)
            key = session_new()
            body = json.dumps({"ok": True, "key": key}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Set-Cookie", "cnmkey=%s; Path=/; Max-Age=%d; SameSite=Lax" % (key, SESS_TTL))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _is_local(self):
            """只有显式开了 LOCAL_BYPASS 才认本机（反代后面所有请求都像本机，不能靠它）。"""
            if not LOCAL_BYPASS:
                return False
            try:
                h = self.client_address[0]
            except Exception:
                return False
            return h in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

        def _api_cred_delete(self):
            if not self._authed():
                return self._json({"ok": False, "code": "locked", "error": "需要先输入访问密码"}, 403)
            try:
                if os.path.exists(CRED_PATH):
                    os.remove(CRED_PATH)
            except OSError:
                pass
            return self._json({"ok": True})

        def _api_cred_get(self):
            if not self._authed():
                return self._json({"ok": False, "code": "locked",
                                   "error": "需要先输入访问密码"}, 403)
            c = cred_read()
            if not c:
                return self._json({"ok": True, "cred": None})
            return self._json({"ok": True, "cred": {
                "kind": c.get("kind", ""),
                "token": c.get("token", ""), "cookie": c.get("cookie", ""),
                "ua": c.get("ua", ""), "hdr": c.get("hdr", ""),
                "model": c.get("model", ""),
                "apiKey": c.get("apiKey", ""), "apiBase": c.get("apiBase", ""), "apiModel": c.get("apiModel", ""),
                "savedAt": c.get("savedAt", "")
            }})

        def _api_cred_put(self):
            if not self._authed():
                return self._json({"ok": False, "code": "locked",
                                   "error": "需要先输入访问密码"}, 403)
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n > 0 else b"{}"
                payload = json.loads(raw.decode("utf-8"))
            except Exception:
                return self._json({"ok": False, "error": "bad json"}, 400)
            tok = str(payload.get("token") or "").strip()
            api_key = str(payload.get("apiKey") or "").strip()
            if len(tok) < 8 and len(api_key) < 8:
                return self._json({"ok": False, "error": "没有可保存的凭据"}, 400)
            rec = {
                "kind": str(payload.get("kind") or ("direct" if api_key else "web")),
                "token": tok,
                "cookie": str(payload.get("cookie") or ""),
                "ua": str(payload.get("ua") or ""),
                "hdr": str(payload.get("hdr") or ""),
                "model": str(payload.get("model") or "deepseek"),
                "apiKey": api_key,
                "apiBase": str(payload.get("apiBase") or "https://api.deepseek.com"),
                "apiModel": str(payload.get("apiModel") or "deepseek-chat"),
                "savedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }
            cred_write(rec)
            return self._json({"ok": True, "savedAt": rec["savedAt"]})

        def _health(self):
            st = relay.env_status() if relay else {"node": None}
            body = json.dumps({
                "ok": bool(relay and st.get("node") and st.get("solver") and st.get("wasm")),
                "service": "cnm-site",
                "hasRelay": bool(relay),
                "hasStore": True,
                "hasCred": bool(cred_read()),
                "env": st,
                "root": ROOT,
            }, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    return Handler


def main():
    port = int(os.environ.get("PORT") or 0)
    host = os.environ.get("HOST") or ("0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
    relay = load_relay()

    if not port:
        for p in range(8899, 8920):
            try:
                httpd = ThreadingHTTPServer((host, p), make_handler(relay))
                port = p
                break
            except OSError:
                continue
        else:
            print("没有空闲端口，试 PORT=xxxx python3 server.py")
            return 1
    else:
        httpd = ThreadingHTTPServer((host, port), make_handler(relay))

    httpd.daemon_threads = True
    print("  站点      http://%s:%d/" % ("127.0.0.1" if host == "0.0.0.0" else host, port))
    print("  转发接口  /api/ds/v1/chat/completions  (%s)" % ("已加载" if relay else "没找到 tools/dsweb-relay.py"))
    print("  目录      %s" % ROOT)
    print("  Ctrl+C 停止\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
