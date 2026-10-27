/* 复习与考察 · 大模型通道
   ----------------------------------------------------------------------------
   两条路，同一套调用方式：

   ① 云端（默认）：WorkBuddy 云服务的 chat.completions，免密钥、只支持流式。
      不在前端持有长期密钥，也不自建代理。
   ② 网页版：浏览器 → 本机中转（tools/dsweb-relay.py）→ chat.deepseek.com。
      凭据是家长自己从浏览器里复制的一条 curl，只存在这台设备上；过期了重新贴一条。
      网页版支持把手机拍的照片一起发过去判分。

   暴露 window.RvLLM：
     available()               当前通道是否就绪
     listModels()              可用模型（网页版是固定的三个）
     pickDefault(models)       默认模型
     complete(opts)            流式收全文，返回字符串；opts.images 放 data URL
     parseJson(text)           从模型输出里取出 JSON（容忍代码块、前后废话、尾逗号）
     describeError(err)        把错误码翻译成能给学生家长看的一句话
     web / parseCurl / probe / health   网页版通道的配置与自检
   ========================================================================== */
(function () {
  'use strict';

  var CFG = (typeof window !== 'undefined' && window.CNM_CLOUD_CONFIG) || null;
  var LS_CHAN = 'cnmReview.chan.v1';

  var client = null;
  var modelsCache = null;
  var modelsPromise = null;

  /* 网页版就是 chat.deepseek.com 那个对话框：联网搜索和深度思考是它自己的开关，
     网页端默认都开着，这边不再让用户配。 */
  var WEB_MODELS = [
    { id: 'deepseek', name: 'DeepSeek 网页版', descriptionZh: '自带联网搜索与深度思考，不用另外设置。' }
  ];

  var WEB_DEFAULT = {
    kind: 'cloud',
    relay: '',                 /* 留空 = 用本站 /api/ds；只有 file:// 才回落到 8790 */

    token: '',
    cookie: '',
    ua: '',
    hdr: '',            /* 从 curl 里带出来的整套请求头（base64 JSON），转发给中转 */
    model: 'deepseek',
    auto: false,          /* true = 转发地址是自动探测到的（本机服务），换域名时不要改写它 */
    savedAt: ''
  };

  /* 凭据失效时通知外面弹窗：只在这一个地方挂一次，避免多处提示打架 */
  var authSink = null;
  function onAuthFail(fn) { authSink = fn; }
  function notifyAuth(msg) {
    if (!authSink) return;
    try { authSink(msg); } catch (e) {}
  }

  function b64json(o) {
    try { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))); } catch (e) { return ''; }
  }

  function sdkMissing() {
    return !!window.__CNM_SDK_FAILED ||
      !window.WorkBuddyCloud ||
      typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function';
  }

  /* 云端通道只认发布后的正式域名：本机 / 预览地址上 SDK 会弹
     「当前地址暂不支持此登录方式」，干脆不建客户端，让用户走网页版。 */
  function cloudOriginOk() {
    try {
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
      var h = location.hostname;
      if (!h || h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '[::1]') return false;
      if (/\.local$/i.test(h)) return false;
      if (/^(10|127)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
      return true;
    } catch (e) { return false; }
  }

  function getClient() {
    if (client) return client;
    if (!cloudOriginOk()) return null;
    if (sdkMissing()) return null;
    if (!CFG || !CFG.endpoint || !CFG.publishableKey) return null;
    try {
      client = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
        publishableKey: CFG.publishableKey
      });
    } catch (e) {
      client = null;
    }
    return client;
  }

  /* ---------------------------------------------------------------- 网页版配置 */

  function web() {
    var v = null;
    try { v = JSON.parse(localStorage.getItem(LS_CHAN)); } catch (e) { v = null; }
    var out = {};
    Object.keys(WEB_DEFAULT).forEach(function (k) {
      out[k] = (v && v[k] !== undefined && v[k] !== null) ? v[k] : WEB_DEFAULT[k];
    });
    if (out.kind !== 'web') out.kind = 'cloud';
    /* 本机 / 预览地址用不了云端（SDK 不给登录），没手动选过就默认走网页版，
       否则一进来就是「通道不可用」，还得自己猜要切哪里。 */
    if (out.kind === 'cloud' && !cloudOriginOk() && !(v && v.kind)) out.kind = 'web';
    return out;
  }

  function setWeb(patch) {
    var next = web();
    Object.keys(patch || {}).forEach(function (k) { next[k] = patch[k]; });
    if (patch && (patch.token || patch.cookie || patch.relay)) next.savedAt = new Date().toISOString();
    try { localStorage.setItem(LS_CHAN, JSON.stringify(next)); } catch (e) {}
    modelsCache = null;
    return next;
  }

  function isWeb() { return web().kind === 'web'; }

  /* 从浏览器 DevTools 里「Copy as cURL」粘过来的那串里取凭据。
     只要 token 也能用：整段就是一个长串，没有冒号的，当作 userToken。
     DeepSeek 现在除了 token 还要 x-device-id、x-hif-* 这类头才认，
     所以把整套请求头一起收下来（存本地，换设备要重贴）。 */
  var HDR_KEEP = [
    'user-agent', 'x-client-version', 'x-client-platform', 'x-client-locale',
    'x-client-bundle-id', 'x-client-timezone-offset', 'x-device-id',
    'x-hif-dliq', 'x-hif-leim'
  ];

  function parseCurl(text) {
    var s = String(text || '').replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ');
    var out = { token: '', cookie: '', ua: '', hdr: '' };
    var extra = {};

    var re = /(?:^|\s)(?:-H|--header)\s+(['"])([\s\S]*?)\1/g;
    var m;
    while ((m = re.exec(s))) {
      var line = m[2];
      var i = line.indexOf(':');
      if (i <= 0) continue;
      var k = line.slice(0, i).trim().toLowerCase();
      var v = line.slice(i + 1).trim();
      if (!k || !v) continue;
      if (k === 'authorization') {
        var mm = v.match(/bearer\s+(\S+)/i);
        if (mm) out.token = mm[1];
        continue;
      }
      if (k === 'cookie') { out.cookie = v.replace(/[\\'"]+$/, ''); continue; }
      if (HDR_KEEP.indexOf(k) >= 0) extra[k] = v;
    }

    if (!out.cookie) {
      var b = s.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/);
      if (b) out.cookie = b[2].trim().replace(/[\\'"]+$/, '');
    }
    out.ua = extra['user-agent'] || '';

    if (!out.token) {
      var t = s.trim().replace(/^['"]|['"]$/g, '');
      if (/^[A-Za-z0-9_\-\/+=.]{16,}$/.test(t)) out.token = t;
    }
    if (Object.keys(extra).length) out.hdr = b64json(extra);
    return out;
  }

  /* 中转地址：部署在云上时走「同站转发」（页面和转发在同一个服务里，没有跨域这回事，
     手机、别人电脑都能用，也不用在自己电脑上开 8790）；本机调试才用 127.0.0.1。 */
  function defaultRelay() {
    /* 双击「启动.command」起的服务本身就把 /api/ds 带上了，页面和转发同源——
       本机也不例外，不用再另开 8790 那个中转。只有直接 file:// 打开才退回落。 */
    if (location.protocol === 'file:') return 'http://127.0.0.1:8790';
    return location.origin + '/api/ds';
  }
  function sameSiteRelay() {
    if (location.protocol === 'file:') return '';
    return String(location.origin || '') + '/api/ds';
  }

  function relayBase(cfg) {
    var conf = cfg || web();
    var r = String(conf.relay || '').replace(/\/+$/, '');
    if (!r) return defaultRelay();
    /* auto = 自动探测到的（可能在本机 8981 上），别再按「云上」规则改写它 */
    if (conf.auto) return r;
    /* 旧配置里存着 127.0.0.1：在云端页面上这个地址指向「看网页那台设备」，手机上必然打不通，
       直接改用同站转发，不给用户留一个打了也白打的地址。 */
    var local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(r);
    var onLocalhost = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
    if (local && !onLocalhost && /^https?:$/.test(location.protocol)) {
      return location.origin + '/api/ds';
    }
    return r;
  }

  /* ---------------------------------------------------------------- 通道状态 */

  function available() {
    if (isWeb()) {
      var c = web();
      return !!c.token && /^https?:\/\//.test(String(relayBase(c) || ''));
    }
    return !!getClient();
  }

  function usable(m) { return m && m.disabled !== true && m.enabled !== false; }

  function listModels() {
    if (isWeb()) {
      modelsCache = WEB_MODELS.slice();
      return Promise.resolve(modelsCache);
    }
    if (modelsCache) return Promise.resolve(modelsCache);
    if (modelsPromise) return modelsPromise;
    var c = getClient();
    if (!c) return Promise.reject(makeErr('sdk'));
    modelsPromise = Promise.resolve()
      .then(function () { return c.llm.models.list(); })
      .then(function (arr) {
        modelsCache = (Array.isArray(arr) ? arr : []).filter(usable);
        modelsPromise = null;
        return modelsCache;
      })
      .catch(function (e) {
        modelsPromise = null;
        throw e;
      });
    return modelsPromise;
  }

  function isDeepSeek(m) {
    var s = String((m && m.id) || '') + ' ' + String((m && m.name) || '');
    return /deepseek/i.test(s);
  }

  function pickDefault(models) {
    var list = (models || []).filter(usable);
    if (!list.length) return isWeb() ? 'deepseek' : '';
    if (isWeb()) {
      var pref = web().model;
      if (list.some(function (m) { return m.id === pref; })) return pref;
      return list[0].id;
    }
    var ds = list.filter(isDeepSeek);
    if (ds.length) {
      var flash = ds.filter(function (m) { return /flash/i.test(m.id); })
        .filter(function (m) { return !/v3/i.test(m.id); });
      if (flash.length) return flash[flash.length - 1].id;
      return ds[0].id;
    }
    var d = list.filter(function (m) { return m.isDefault; });
    if (d.length) return d[0].id;
    return list[0].id;
  }

  function makeErr(code, detail, extra) {
    var e = new Error(detail || code);
    e.error = { code: code, message: detail || code };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  /* ---------------------------------------------------------------- 调用 */

  function userContent(o) {
    var images = (o.images || []).filter(Boolean).slice(0, 4);
    if (!images.length) return typeof o.user === 'string' ? o.user : '';
    var parts = [{ type: 'text', text: o.user || '' }];
    images.forEach(function (url) {
      parts.push({ type: 'image_url', image_url: { url: url } });
    });
    return parts;
  }

  /* 云端：WorkBuddy 云服务，只支持流式 */
  function cloudComplete(o) {
    var c = getClient();
    if (!c) return Promise.reject(makeErr('sdk'));
    var text = '';
    var reasoning = 0;
    return (async function () {
      var stream = c.llm.chat.completions.create({
        model: o.model,
        messages: [
          { role: 'system', content: o.system },
          { role: 'user', content: userContent(o) }
        ],
        stream: true,
        stream_options: { include_usage: true },
        temperature: typeof o.temperature === 'number' ? o.temperature : 0.7,
        signal: o.signal
      });
      for await (var chunk of stream) {
        var ch = chunk && chunk.choices && chunk.choices[0];
        var d = ch && ch.delta;
        if (d && d.content) {
          text += d.content;
          if (o.onProgress) { try { o.onProgress(text.length, reasoning); } catch (e) {} }
        }
        if (d && d.reasoning_content) {
          reasoning += d.reasoning_content.length;
          if (o.onProgress) { try { o.onProgress(text.length, reasoning); } catch (e) {} }
        }
      }
      return text;
    })();
  }

  /* 网页版：本机中转 → chat.deepseek.com，读它转出来的 OpenAI 流 */
  function webComplete(o) {
    var cfg = web();
    var base = relayBase(cfg);
    if (!base) return Promise.reject(makeErr('web_no_relay'));
    if (!cfg.token) return Promise.reject(makeErr('web_no_token'));

    var headers = { 'Content-Type': 'application/json' };
    headers.Authorization = 'Bearer ' + cfg.token;
    if (cfg.cookie) headers['X-DS-Cookie'] = cfg.cookie;
    if (cfg.ua) headers['X-DS-UA'] = cfg.ua;
    if (cfg.hdr) headers['X-DS-Headers'] = cfg.hdr;

    var body = {
      model: o.model || cfg.model || 'deepseek',
      stream: true,
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content: userContent(o) }
      ]
    };

    var text = '';
    var reasoning = 0;

    function feed(chunk) {
      var ch = chunk && chunk.choices && chunk.choices[0];
      var d = ch && ch.delta;
      if (d && d.content) {
        text += d.content;
        if (o.onProgress) { try { o.onProgress(text.length, reasoning); } catch (e) {} }
      }
      if (d && d.reasoning_content) {
        reasoning += d.reasoning_content.length;
        if (o.onProgress) { try { o.onProgress(text.length, reasoning); } catch (e) {} }
      }
    }

    function line(payload) {
      if (!payload || payload === '[DONE]') return;
      var j;
      try { j = JSON.parse(payload); } catch (e) { return; }
      if (j && j.error) {
        var code = j.error.code || 'web_failed';
        if (code === 'token_invalid' || code === 'token_missing') notifyAuth(j.error.message);
        throw makeErr(code, j.error.message || code);
      }
      feed(j);
    }

    return fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: o.signal
    }).catch(function (e) {
      if (e && (e.name === 'AbortError' || /abort/i.test(String(e.message)))) throw e;
      throw makeErr('web_offline', '连不上 ' + base);
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (raw) {
          var j = null;
          try { j = JSON.parse(raw); } catch (e) {}
          var err = (j && j.error) || {};
          var code = err.code || ('web_http_' + res.status);
          if (res.status === 401 || res.status === 403 || code === 'token_invalid') notifyAuth(err.message);
          throw makeErr(code, err.message || ('HTTP ' + res.status));
        });
      }
      if (!res.body || !res.body.getReader) {
        return res.text().then(function (raw) {
          raw.split('\n').forEach(function (l) {
            var s = l.trim();
            if (s.indexOf('data:') === 0) line(s.slice(5).trim());
          });
          return text;
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder('utf-8');
      var buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            if (buf.trim()) buf.split('\n').forEach(function (l) {
              var s = l.trim();
              if (s.indexOf('data:') === 0) line(s.slice(5).trim());
            });
            return text;
          }
          buf += dec.decode(r.value, { stream: true });
          var cut;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            var block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            block.split('\n').forEach(function (l) {
              var s = l.trim();
              if (s.indexOf('data:') === 0) line(s.slice(5).trim());
            });
          }
          return pump();
        });
      }
      return pump();
    });
  }

  /* opts: { model, system, user, images, temperature, signal, onProgress }
     onProgress(chars, reasoningChars) 在每收到一段内容时回调。 */
  function complete(opts) {
    var o = opts || {};
    var system = o.system || '你是一位严谨的中小学教研员。只输出要求的 JSON。';
    var user = o.user || '';
    if (!user) return Promise.reject(makeErr('request_empty', '题目要求为空'));
    var base = {
      model: o.model, system: system, user: user, images: o.images,
      temperature: o.temperature, signal: o.signal, onProgress: o.onProgress
    };

    if (isWeb()) {
      /* 静态托管的地址（预览面板 / 只跑了个文件服务器）会被 POST 501 或 404 掉。
         这不是用户填错了什么——自动找一次能用的转发，找到就悄悄换过去重发一次。 */
      return webComplete(base).catch(function (e) {
        var code = (e && e.error && e.error.code) || '';
        /* 静态服务器有的回 501/404，有的直接断连（web_offline）——都当成「这个地址不转发」 */
        if (!/^web_http_(404|405|501)$/.test(code) && code !== 'web_offline') throw e;
        return detectRelay().then(function (hit) {
          if (!hit) throw makeErr('web_no_relay', '这个地址没有转发');
          setWeb({ relay: hit.base === sameSiteRelay() ? '' : hit.base, auto: hit.base !== sameSiteRelay() });
          return webComplete(base);
        });
      });
    }

    /* 云端不保证支持图片。带了图但被拒时，退回纯文字再批一次，别让整张卷子卡住。 */
    return cloudComplete(base).catch(function (e) {
      var code = (e && e.error && e.error.code) || '';
      if (base.images && base.images.length && /^(request_|model_|gateway_|internal_)/.test(code)) {
        var retry = {};
        Object.keys(base).forEach(function (k) { retry[k] = base[k]; });
        retry.images = null;
        return cloudComplete(retry).then(function (t) {
          var err = makeErr('image_dropped', '图片没被云端接收，这次按文字批改');
          err.droppedImages = true;
          err.text = t;
          throw err;
        });
      }
      throw e;
    });
  }

  /* 网页版自检：顺带把 node/wasm 状态带回来，出问题能一眼看出卡在哪 */
  function probe(payload) {
    var cfg = web();
    var base = relayBase(cfg);
    if (!base) return Promise.reject(makeErr('web_no_relay'));
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    if (cfg.cookie) headers['X-DS-Cookie'] = cfg.cookie;
    if (cfg.hdr) headers['X-DS-Headers'] = cfg.hdr;
    return fetch(base + '/v1/probe', {
      method: 'POST', headers: headers, body: JSON.stringify(payload || {})
    }).catch(function (e) {
      throw makeErr('web_offline', '连不上 ' + base);
    }).then(function (r) { return r.json(); });
  }

  /* 老配置里存的是 127.0.0.1:8790（以前要单独起中转）。现在页面本身就带着 /api/ds，
     进页面时探一次，探到就把地址改回「本站」，免得人以为还得再开一个服务。
     各页不用各写一份，等它就好。 */
  var relayPromise = null;
  function ensureRelay() {
    if (relayPromise) return relayPromise;
    relayPromise = (function () {
      if (!/^https?:$/.test(location.protocol)) return Promise.resolve(false);
      var cfg = web();
      var stored = String(cfg.relay || '');
      /* 没配凭据的人用不到转发，别在控制台里刷一堆探测失败 */
      if (!cfg.token) return Promise.resolve(false);
      /* 旧配置里存着 8790：如果这个页面本身带转发，就改回「本站」 */
      if (/^http:\/\/(127\.0\.0\.1|localhost):87\d\d$/.test(stored)) {
        var site0 = sameSiteRelay();
        if (site0) {
          return fetch(site0 + '/health', { method: 'GET' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
              if (j && j.service === 'dsweb-relay') { setWeb({ relay: '', auto: false }); return true; }
              return false;
            })
            .catch(function () { return false; });
        }
        return Promise.resolve(false);
      }
      if (stored) return Promise.resolve(false);   // 用户自己指定过，不猜
      /* 没指定：先看本站有没有，没有再找本机跑着的那个（预览面板里页面不在这台服务上） */
      var cands = relayCandidates();
      /* 并行探，别一个个排队等超时（静态托管时整串都要失败一遍） */
      return Promise.all(cands.map(function (base) {
        return healthOf(base).then(function (hit) { return hit ? base : null; });
      })).then(function (rs) {
        var base = null;
        for (var i = 0; i < rs.length; i++) if (rs[i]) { base = rs[i]; break; }
        if (!base) return false;
        var sameNow = base === sameSiteRelay();
        /* 同站就留空（跟着地址走）；本机的打 auto，换地址后不会被改写 */
        if (sameNow) { if (stored !== '') setWeb({ relay: '', auto: false }); }
        else setWeb({ relay: base, auto: true });
        return true;
      });
    })();
    return relayPromise;
  }

  function health() {
    var base = relayBase(web());
    if (!base) return Promise.reject(makeErr('web_no_relay'));
    return fetch(base + '/health', { method: 'GET' })
      .catch(function () { throw makeErr('web_offline', '连不上 ' + base); })
      .then(function (r) { return r.json(); });
  }

  /* 地址填错、端口换了、服务没起，都会落到「连不上」这一句上。
     这里把本机几个常见端口扫一遍，找到了就顺手改掉地址，省得人去猜。 */
  function healthOf(base) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (e) {} }, 1200);
    return fetch(base + '/health', { signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        return (j && j.service === 'dsweb-relay') ? { base: base, info: j } : null;
      })
      .catch(function () { clearTimeout(timer); return null; });
  }

  function relayCandidates() {
    var out = [];
    var site = sameSiteRelay();
    if (site) out.push(site);
    /* 页面被别的地址托管时（预览面板之类），服务可能还在 8981 / 8790 上独立跑着 */
    ['127.0.0.1', 'localhost'].forEach(function (h) {
      out.push('http://' + h + ':8981/api/ds');
      for (var p = 8790; p <= 8792; p++) out.push('http://' + h + ':' + p);
    });
    return out;
  }

  function detectRelay() {
    var cur = relayBase(web());
    var cands = [];
    var site = sameSiteRelay();
    if (site && site !== cur) cands.push(site);
    if (cur) cands.push(cur);
    relayCandidates().forEach(function (u) { if (u !== cur && cands.indexOf(u) < 0) cands.push(u); });
    return Promise.all(cands.map(healthOf)).then(function (rs) {
      var hit = null;
      rs.forEach(function (x) { if (!hit && x) hit = x; });
      return hit;
    });
  }

  /* ---------------------------------------------------------------- 解析 */

  /* 模型输出是不可信文本：只当作 JSON 解析，绝不执行 */
  function parseJson(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) throw makeErr('model_empty', '模型没有返回内容');
    s = s.replace(/^\uFEFF/, '');
    s = s.replace(/^```(?:json|JSON)?\s*/m, '').replace(/```\s*$/m, '').trim();

    var first = s.indexOf('{');
    var last = s.lastIndexOf('}');
    if (first > 0 || (last >= 0 && last < s.length - 1)) {
      if (first >= 0 && last > first) s = s.slice(first, last + 1);
    }
    try {
      return JSON.parse(s);
    } catch (e) {
      var fixed = s
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
      try {
        return JSON.parse(fixed);
      } catch (e2) {
        throw makeErr('model_bad_json', '模型返回的格式不对');
      }
    }
  }

  function describeError(err) {
    var code = (err && err.error && err.error.code) || (err && err.code) || '';
    var msg = (err && err.error && err.error.message) || (err && err.message) || '';
    if (code === 'sdk') {
      if (!cloudOriginOk()) return '云端通道只在发布后的网址上能用；这个地址请把出题通道切到「网页版」（用你自己的 DeepSeek 账号）。';
      return '云端模型通道没加载成功，检查网络后刷新页面再试。';
    }
    if (code === 'request_empty') return '还没准备好题目要求，请重新选择知识点。';
    if (code === 'model_empty') return '模型这次什么都没返回，再点一次「重新生成」通常就好。';
    if (code === 'model_bad_json') return '模型返回的题目格式不对，点「重新生成」再试一次。';
    if (code === 'image_dropped') return '照片没被云端接收，这次只按文字批改。想拍照批改，把通道换成「网页版」。';
    if (code === 'web_no_relay') return '网页版的转发没准备好，重新用「启动.command」打开页面再试。';
    if (code === 'web_no_token') return '还没贴登录凭据。在 chat.deepseek.com 上复制一条 curl 贴进来。';
    if (code === 'web_offline') return '转发服务没响应，等几秒再试一次；一直不行就重新用「启动.command」打开页面。';
    if (/^web_http_(404|405|501)$/.test(code)) return '这个地址没有转发能力（静态预览常见）。用「启动.command」打开的页面，或者发布后的网址。';
    if (code === 'token_missing' || code === 'token_invalid') return 'DeepSeek 登录凭据过期了。重新在浏览器里复制一条 curl 贴上就好。';
    if (code === 'node_missing') return '转发那边没找到 Node.js（网页版解开挑战要靠它），本机调试的话装好 Node 再重启。';
    if (code === 'solver_missing') return '转发服务缺少 tools/dsweb 里的求解文件。';
    if (code === 'image_too_large') return '照片太大，压缩后重拍一张（8MB 以内）。';
    if (code === 'upload_failed') return '照片没传上去，重拍一张或先只交文字。';
    if (code === 'empty' || code === 'web_failed') return 'DeepSeek 这次没返回内容，隔十几秒再试；也可能是内容被风控拦了。';
    if (/^auth_/.test(code)) return '当前网址不在模型通道的授权范围内（本地预览地址常见），部署后的正式域名可以正常用。';
    if (/^quota_/.test(code)) {
      if (code === 'quota_rate_limited') return '请求太密集了，等十几秒再试。';
      return '云端模型额度用完了，需要补充后才能继续出题。';
    }
    if (/^gateway_/.test(code) || /^model_/.test(code)) return '模型服务暂时不可用，稍等一下重新生成。';
    if (/^request_/.test(code)) return '请求参数和模型不匹配，换个模型再试。';
    if (code === 'AbortError' || /aborted/i.test(msg)) return '已取消。';
    if (/^internal_/.test(code)) return '云端出了点问题' + ((err && err.requestId) ? '（编号 ' + err.requestId + '）' : '') + '，稍后重试。';
    return msg || '出错了，请稍后重试。';
  }

  ensureRelay();

  window.RvLLM = {
    available: available,
    listModels: listModels,
    pickDefault: pickDefault,
    complete: complete,
    parseJson: parseJson,
    describeError: describeError,
    isDeepSeek: isDeepSeek,
    web: web,
    setWeb: setWeb,
    isWeb: isWeb,
    parseCurl: parseCurl,
    probe: probe,
    health: health,
    detectRelay: detectRelay,
    onAuthFail: onAuthFail,
    relayBase: relayBase,
    cloudOriginOk: cloudOriginOk,
    usingSiteRelay: function () { return /\/api\/ds$/.test(relayBase()); },
    sameSiteRelay: sameSiteRelay,
    ensureRelay: ensureRelay,
    WEB_MODELS: WEB_MODELS
  };
})();
