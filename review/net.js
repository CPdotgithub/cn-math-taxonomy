/* 复习与考察 · 联网素材
   ----------------------------------------------------------------------------
   作用：出题前先去网上找几段「同年级同知识点的题型/易错点」素材，塞进命题提示，
         让题目更贴近真实考法，而不是只靠模型记忆。

   边界（重要）：
   - 素材只作题型参考，不作答案依据；提示词里已明确要求模型自行判断对错。
   - 不经过我们自己的服务器，全部是浏览器直接发请求，所以抓取用的是支持跨域的
     Jina Reader（把网页转成纯文本）。搜索源需要用户自己的 key，存在本机。
   ========================================================================== */
(function () {
  'use strict';

  var LS = 'cnmReview.web.v1';
  var READER = 'https://r.jina.ai/';
  var TIMEOUT = 15000;

  function cfg() {
    try {
      var v = JSON.parse(localStorage.getItem(LS));
      return v && typeof v === 'object' ? v : { provider: '', key: '' };
    } catch (e) { return { provider: '', key: '' }; }
  }
  function save(c) {
    try { localStorage.setItem(LS, JSON.stringify(c || {})); } catch (e) {}
  }
  function configured() {
    var c = cfg();
    return !!(c.provider && c.key);
  }

  function withTimeout(promise, ms) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, ms || TIMEOUT);
    return Promise.resolve(promise(ctl.signal)).finally(function () { clearTimeout(timer); });
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  /* 把网页转成纯文本（支持跨域的阅读器，不需要 key） */
  function read(url) {
    var u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return withTimeout(function (signal) {
      return fetch(READER + u, {
        signal: signal,
        headers: { 'Accept': 'text/plain' }
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      });
    }).then(function (text) {
      return { ok: true, url: u, host: hostOf(u), title: hostOf(u), text: String(text || '') };
    }).catch(function (e) {
      return { ok: false, url: u, host: hostOf(u), error: String(e && e.message || e) };
    });
  }

  function tavily(q, key, signal) {
    return fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: q, search_depth: 'basic', max_results: 3, include_answer: false })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      return (j.results || []).slice(0, 3).map(function (x) {
        return { title: x.title || hostOf(x.url), url: x.url, text: x.content || '' };
      });
    });
  }

  function serper(q, key, signal) {
    return fetch('https://google.serper.dev/search', {
      method: 'POST',
      signal: signal,
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({ q: q, num: 3, hl: 'zh-cn' })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      return (j.organic || []).slice(0, 3).map(function (x) {
        return { title: x.title || hostOf(x.link), url: x.link, text: x.snippet || '' };
      });
    });
  }

  /* 返回 { ok, items:[{title,url,text}], note } */
  function search(q) {
    var c = cfg();
    if (!c.provider || !c.key) return Promise.resolve({ ok: false, items: [], note: 'unconfigured' });
    var q2 = String(q || '').slice(0, 80);
    return withTimeout(function (signal) {
      return c.provider === 'serper' ? serper(q2, c.key, signal) : tavily(q2, c.key, signal);
    }).then(function (items) {
      return { ok: true, items: items.filter(function (x) { return x && x.url; }), note: '' };
    }).catch(function (e) {
      return { ok: false, items: [], note: String(e && e.message || e) };
    });
  }

  /* 收集素材：手动给的链接优先，其次按关键词搜。全部失败就返回空数组，不阻断出题。 */
  function collect(opts) {
    var o = opts || {};
    var links = (o.links || []).filter(Boolean).slice(0, 3);
    var jobs = [];

    if (links.length) {
      jobs = links.map(function (u) { return read(u); });
      return Promise.all(jobs).then(clean);
    }
    if (!o.query) return Promise.resolve([]);
    return search(o.query).then(function (r) {
      if (!r.ok || !r.items.length) return [];
      return Promise.all(r.items.map(function (it) {
        if (it.text && it.text.length > 300) return { ok: true, title: it.title, url: it.url, host: hostOf(it.url), text: it.text };
        return read(it.url).then(function (page) {
          if (!page.ok) return { ok: true, title: it.title, url: it.url, text: it.text };
          page.title = it.title || page.title;
          return page;
        });
      })).then(clean);
    });
  }

  function clean(arr) {
    return (arr || []).filter(function (x) { return x && x.ok && x.text; }).map(function (x) {
      return {
        title: x.title || hostOf(x.url),
        url: x.url,
        text: String(x.text).replace(/\n{3,}/g, '\n\n').slice(0, 1800)
      };
    });
  }

  window.RvWeb = {
    cfg: cfg,
    save: save,
    configured: configured,
    read: read,
    search: search,
    collect: collect,
    host: hostOf
  };
})();
