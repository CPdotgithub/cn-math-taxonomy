# 网页版通道 · 本机中转

「复习与考察」有两种出题通道：**云端**（默认，免密钥，只能发文字）和 **网页版**
（用你自己的 DeepSeek 账号，能连手写照片一起判）。网页版需要在自己电脑上跑一个
很小的中转服务，就是这里的 `dsweb-relay.py`。

## 为什么必须有这个中转

浏览器里的网页不能直接请求 chat.deepseek.com：

- 跨域被拦（CORS），前端拿不到响应；
- 每次对话要带一个 PoW 挑战头，得用官方 wasm 现算，还得有个 Node 进程。

中转就干这两件事，然后把结果按 OpenAI 的格式流式吐回来。它不存凭据、不记录内容、
只监听 `127.0.0.1`，也不会上传到任何第三方。

## 怎么用

1. 双击 `start-dsweb.command`（或命令行 `python3 tools/dsweb-relay.py`）。
   看到 `DeepSeek 网页版中转已启动： http://127.0.0.1:8790` 就行，窗口留着别关。
2. 打开 chat.deepseek.com，随便发一句话，在开发者工具的 Network 里找到
   `completion` 请求，右键 → **Copy as cURL**。
3. 回到网站的「复习与考察 → 出题设置 → 模型与联网素材」，通道切到 **网页版**，
   把 curl 粘进「登录凭据」，点「换一条凭据」。下方出现「连接正常」就通了。
4. 凭据会过期（一般几周）。过期后页面会提示，重复第 2–3 步即可。

> 不要把手写的 token 拼进 URL 或发到聊天群，这条 curl 里就是你的登录态。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 自检：node / solver / wasm 是否就绪 |
| POST | `/v1/probe` | 带着凭据问一句「我是谁」，验证 token 是否还有效 |
| POST | `/v1/chat/completions` | OpenAI 兼容；`messages[].content` 支持 `image_url`（data URL 或网址） |

`Authorization: Bearer <userToken>`、`X-DS-Cookie: <cookie>` 由网页随请求带过来。

## 几个常见问题

- **默认端口 8790**。被占用就 `python3 tools/dsweb-relay.py --port 8791`，网页里的地址也跟着改。
- **线上是 https，中转是 http://127.0.0.1**：Chrome / Edge / Firefox 都把 127.0.0.1
  当作可信来源，不会被拦；Safari 偶尔会拦混合内容，换 Chrome 即可。
- **提示「没找到 node」**：PoW 求解要 Node.js，装好后重启中转服务（不用重装别的）。
- **凭据过期**：页面会提示「登录凭据过期了」，重新 Copy as cURL 贴一次就行，不用重启服务。

## 文件

- `dsweb-relay.py` —— 中转本体，只用 Python 标准库
- `dsweb/solver.js` + `dsweb/sha3_wasm_bg.wasm` —— DeepSeekHashV1 的 PoW 求解器
- `start-dsweb.command` —— 双击启动

`tools/` 不参与站点构建，不会被发布到线上。
