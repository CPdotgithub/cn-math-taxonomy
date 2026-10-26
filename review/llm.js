/* 复习与考察 · 云端大模型通道
   ----------------------------------------------------------------------------
   走 WorkBuddy 云服务的 chat.completions（免密钥、只支持流式），优先 DeepSeek。
   不在前端持有任何长期密钥，也不自建代理。

   暴露 window.RvLLM：
     available()               云端通道是否就绪（SDK + 配置）
     listModels()              可用模型（缓存）
     pickDefault(models)       默认模型：DeepSeek 优先
     complete(opts)            流式收全文，返回字符串
     parseJson(text)           从模型输出里取出 JSON（容忍代码块、前后废话、尾逗号）
     describeError(err)        把错误码翻译成能给学生家长看的一句话
   ========================================================================== */
(function () {
  'use strict';

  var CFG = (typeof window !== 'undefined' && window.CNM_CLOUD_CONFIG) || null;
  var client = null;
  var modelsCache = null;
  var modelsPromise = null;

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

  function available() { return !!getClient(); }

  /* 模型目录里 disabled === true / enabled === false 的不可选 */
  function usable(m) { return m && m.disabled !== true && m.enabled !== false; }

  function listModels() {
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

  /* DeepSeek 里优先 Flash（快、稳、便宜），没有就取第一个 DeepSeek，再退到默认模型 */
  function pickDefault(models) {
    var list = (models || []).filter(usable);
    if (!list.length) return '';
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

  function makeErr(code, detail) {
    var e = new Error(detail || code);
    e.error = { code: code, message: detail || code };
    return e;
  }

  /* 流式收全文。opts: { model, system, user, temperature, signal, onProgress }
     onProgress(chars, reasoningChars) 在每收到一段内容时回调。 */
  function complete(opts) {
    var c = getClient();
    if (!c) return Promise.reject(makeErr('sdk'));
    var o = opts || {};
    var system = o.system || '你是一位严谨的中小学教研员。只输出要求的 JSON。';
    var user = o.user || '';
    if (!user) return Promise.reject(makeErr('request_empty', '题目要求为空'));

    var text = '';
    var reasoning = 0;

    return (async function () {
      var stream = c.llm.chat.completions.create({
        model: o.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
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
    isDeepSeek: isDeepSeek
  };
})();
