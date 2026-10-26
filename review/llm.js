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

  /* 网页版没有「模型目录」可查，能选的就是这几种能力组合 */
  var WEB_MODELS = [
    { id: 'deepseek', name: 'DeepSeek 网页版', descriptionZh: '普通对话，速度最快，出题和判分都够用。' },
    { id: 'deepseek-think', name: 'DeepSeek 深度思考', descriptionZh: '先推理再答，题目更绕、更慢；遇到难题再用。' },
    { id: 'deepseek-search', name: 'DeepSeek 联网搜索', descriptionZh: '自己上网找题型，会慢一些，题库更贴近真实考法。' }
  ];

  var WEB_DEFAULT = {
    kind: 'cloud',
    relay: 'http://127.0.0.1:8790',
    token: '',
    cookie: '',
    ua: '',
    model: 'deepseek',
    savedAt: ''
  };

  function sdkMissing() {
    return !!window.__CNM_SDK_FAILED ||
      !window.WorkBuddyCloud ||
      typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function';
  }

  function getClient() {
    if (client) return client;
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
     只要 token 也能用：整段就是一个长串，没有冒号的，当作 userToken。 */
  function parseCurl(text) {
    var s = String(text || '');
    var out = { token: '', cookie: '', ua: '' };
    var m = s.match(/authorization\s*:\s*bearer\s+([A-Za-z0-9_\-\/+=.%]{16,})/i);
    if (m) out.token = m[1];
    var c = s.match(/cookie\s*:\s*([^\n'"]+)/i);
    if (c) out.cookie = c[1].trim().replace(/[\\'"]+$/, '');
    var u = s.match(/user-agent\s*:\s*([^\n'"]+)/i);
    if (u) out.ua = u[1].trim();
    if (!out.token) {
      var t = s.trim().replace(/^['"]|['"]$/g, '');
      if (/^[A-Za-z0-9_\-\/+=.]{16,}$/.test(t)) out.token = t;
    }
    return out;
  }

  function relayBase(cfg) {
    return String((cfg || web()).relay || '').replace(/\/+$/, '');
  }

  /* ---------------------------------------------------------------- 通道状态 */

  function available() {
    if (isWeb()) {
      var c = web();
      return !!c.token && /^https?:\/\//.test(String(c.relay || ''));
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
          throw makeErr(err.code || ('web_http_' + res.status), err.message || ('HTTP ' + res.status));
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

    if (isWeb()) return webComplete(base);

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
    return fetch(base + '/v1/probe', {
      method: 'POST', headers: headers, body: JSON.stringify(payload || {})
    }).catch(function (e) {
      throw makeErr('web_offline', '连不上 ' + base);
    }).then(function (r) { return r.json(); });
  }

  function health() {
    var base = relayBase(web());
    if (!base) return Promise.reject(makeErr('web_no_relay'));
    return fetch(base + '/health', { method: 'GET' })
      .catch(function () { throw makeErr('web_offline', '连不上 ' + base); })
      .then(function (r) { return r.json(); });
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
    if (code === 'sdk') return '云端模型通道没加载成功，检查网络后刷新页面再试。';
    if (code === 'request_empty') return '还没准备好题目要求，请重新选择知识点。';
    if (code === 'model_empty') return '模型这次什么都没返回，再点一次「重新生成」通常就好。';
    if (code === 'model_bad_json') return '模型返回的题目格式不对，点「重新生成」再试一次。';
    if (code === 'image_dropped') return '照片没被云端接收，这次只按文字批改。想拍照批改，把通道换成「网页版」。';
    if (code === 'web_no_relay') return '还没填本机中转地址（形如 http://127.0.0.1:8790）。';
    if (code === 'web_no_token') return '还没贴登录凭据。在 chat.deepseek.com 上复制一条 curl 贴进来。';
    if (code === 'web_offline') return '连不上本机中转服务。先在电脑上双击 tools/start-dsweb.command，再点「测试连接」。';
    if (code === 'token_missing' || code === 'token_invalid') return 'DeepSeek 登录凭据过期了。重新在浏览器里复制一条 curl 贴上就好。';
    if (code === 'node_missing') return '本机没找到 Node.js，网页版解锁挑战要靠它；装好 Node 后重启中转服务。';
    if (code === 'solver_missing') return '中转服务缺少 tools/dsweb 里的求解文件，重新拉一次项目文件。';
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
    WEB_MODELS: WEB_MODELS
  };
})();
