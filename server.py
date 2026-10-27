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
                qs = parse_qs(urlparse(self.path).query)
                key = (qs.get("key") or [""])[0]
                return self._json({"ok": True, "items": store_get(key)})
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
                return self._api_q_put()
            return self._plain(404, "not found")

        def do_OPTIONS(self):
            if relay:
                return relay.Handler.do_OPTIONS(self)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
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

        def _health(self):
            st = relay.env_status() if relay else {"node": None}
            body = json.dumps({
                "ok": bool(relay and st.get("node") and st.get("solver") and st.get("wasm")),
                "service": "cnm-site",
                "hasRelay": bool(relay),
                "hasStore": True,
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
