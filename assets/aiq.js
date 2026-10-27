/* AI 现出题：把「这道题要考的知识点 + 孩子档案」交给大模型，临时命一道可自动判分的题。
   ----------------------------------------------------------------------------
   为什么放在诊断里：固定题库是死的，超前考察（五年级孩子在测六年级）或者某个点的
   具体卡法，题库覆盖不到；模型知道这个孩子哪几个点薄弱、什么教材什么年级，能出得更贴身。

   约束（很关键，否则这道题没法自动判）：
   - 只出「数值题」和「选择题」两种，答案本地比对，不等模型批改；
   - 答案必须能验算，题干不许需要画图 / 查资料；
   - 出一道题一次调用，调用失败就退回题库，答题流程不能卡在网络上。

   暴露 window.CnmAIQ：
     available()        当前通道能不能用（有 token / 有云服务）
     on() / setOn(v)    用户开关（存本机）
     enabled()          on() && available()
     peek(ctx)          { state:'loading'|'ok'|'error', q?, err? } 或 null
     warm(ctx)          预取（答题时先把下一道备好，轮到时不用等）
     buildPrompt(ctx)   调试用
   ========================================================================== */
(function () {
  'use strict';

  var LS_ON = 'cnmDiagnose.ai.v1';
  var TIMEOUT = 28000;

  function llm() { return window.RvLLM || null; }
  function available() { var L = llm(); return !!(L && L.available()); }
  function on() {
    try { var v = localStorage.getItem(LS_ON); return v === null ? true : v === '1'; } catch (e) { return true; }
  }
  function setOn(v) { try { localStorage.setItem(LS_ON, v ? '1' : '0'); } catch (e) { /* 隐私模式 */ } }
  function enabled() { return on() && available(); }

  var SUBJECT = { math: '数学', chinese: '语文', english: '英语', physics: '物理' };

  /* ---------------------------------------------------------------- 档案 */

  /* 简短版学情画像：年级、教材、最近诊断、档案里判为薄弱/不稳的点。
     不塞先修链（诊断页自己有图谱，模型不需要知道那么细），控制在 8 行以内。 */
  function profileText(ctx) {
    var C = window.CnmChildren;
    var kids = C && C.list ? C.list() : [];
    var cur = C && C.current ? C.current() : null;
    var out = [];
    if (cur) {
      out.push('学生档案：' + cur.name + ' · ' + (cur.grade || '未知年级') + (cur.term ? cur.term + '册' : '') +
        (cur.textbook ? ' · ' + cur.textbook : ''));
    } else if (kids.length === 0) {
      out.push('学生档案：还没建档（按下面知识点的教材位置出题即可）');
    }
    var recs = cur && C.recordsOf ? C.recordsOf(cur.id).filter(function (r) { return !ctx.subject || r.subject === ctx.subject; }) : [];
    if (recs.length) {
      var r0 = recs[0];
      out.push('最近一次诊断：' + String(r0.savedAt || '').slice(0, 10) + '「' + (r0.label || '') + '」，测了 ' +
        (r0.asked || 0) + ' 个点，薄弱 ' + ((r0.counts && r0.counts.weak) || 0) + '、不稳 ' + ((r0.counts && r0.counts.shaky) || 0) + '。');
      var st = C.latestStatus ? C.latestStatus(cur.id, ctx.subject) : null;
      var bad = [];
      if (st && ctx.nameOf) {
        Object.keys(st).forEach(function (id) {
          if (st[id].status === 'weak' || st[id].status === 'shaky') bad.push({ id: id, s: st[id].status, at: st[id].at });
        });
      }
      bad.sort(function (a, b) { return (a.s === 'weak' ? 0 : 1) - (b.s === 'weak' ? 0 : 1) || String(b.at).localeCompare(String(a.at)); });
      if (bad.length) {
        out.push('档案里判为有问题的点（最多列 6 个）：' + bad.slice(0, 6).map(function (b) {
          return ctx.nameOf(b.id) + (b.s === 'weak' ? '（薄弱）' : '（不稳）');
        }).join('、'));
        out.push('这些点只用来定题目难度和情境，不要拿它们替换下面这道题的知识点。');
      }
    }
    return out.join('\n');
  }

  /* ---------------------------------------------------------------- 提示词 */

  var SYSTEM = [
    '你是资深教研员，为中国大陆中小学生命制一道诊断用的练习题。',
    '铁律：',
    '1. 只出一道题，答案必须唯一且能验算；数值题答案是一个数（或带单位的量、分数），选择题只有一个正确选项。',
    '2. 不出需要画图、作图、查资料、听录音才能作答的题；不出需要多步长推理（超过 3 步）的题。',
    '3. 不使用 LaTeX、Markdown、表格；数学符号用 Unicode（× ÷ ± ≤ ≥ ≠ ≈ √ π ∠ △ ° ² ³ ½），分数写 3/4，带分数写 1又3/4。',
    '4. 出完自己重算一遍：位数、量级、单位、选项标号，任何一处不确认就换一道更稳的。',
    '5. 只输出一个 JSON 对象，不要解释文字、不要代码块围栏。'
  ].join('\n');

  function clip(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    var a = Array.from(t);
    return a.length > n ? a.slice(0, n).join('') + '…' : t;
  }

  /* ctx: { subject, topic:{id,name,chapter,description,mastery_criteria},
            attempt, difficulty, scopeText, avoid:[题干], bankPrompt,
            probeOptions:[{id,name,strength,desc}] —— 本点 + 它在图谱里的可测先修 } */
  function buildPrompt(ctx) {
    var t = ctx.topic || {};
    var L = [];
    L.push('给下面这名学生出一道练习题。');
    L.push('');
    L.push('【学情】');
    L.push(profileText(ctx));
    if (ctx.scopeText) L.push('这一轮考察范围：' + ctx.scopeText + '（题目必须落在这个范围内，不要跑回孩子档案的年级）');
    L.push('');
    L.push('【这道题要考的知识点】');
    L.push('- 名称：' + (t.name || ''));
    L.push('- 教材位置：' + (t.chapter || '未标注'));
    if (t.description) L.push('- 这个点在说什么：' + clip(t.description, 160));
    if (t.mastery_criteria && t.mastery_criteria.length) {
      L.push('- 学生应该会：' + t.mastery_criteria.slice(0, 3).map(function (x) { return clip(x, 40); }).join('；'));
    }
    L.push('');

    /* 图谱上下文：这道题不是孤立的，答错要能顺着先修往下追 */
    var opts = (ctx.probeOptions || []);
    var pre = opts.filter(function (p) { return p.id !== t.id; });
    if (pre.length) {
      L.push('【它在知识图谱里的位置】');
      L.push('先修（越靠前越硬：不会它，本点基本做不对）：');
      pre.slice(0, 6).forEach(function (p, i) {
        L.push((i + 1) + '. [' + p.id + '] ' + p.name + (p.strength === 'soft' ? '（软先修）' : '（硬先修）') +
          (p.desc ? '：' + clip(p.desc, 40) : ''));
      });
      L.push('这些先修是诊断的分叉口：孩子答错时，我们要能判断是本点没掌握，还是下面某一层断了。');
      L.push('');
    }

    L.push('【难度】' + (ctx.difficulty === 'basic'
      ? '基础：直接考这个点本身，单步或两步，答对说明会了'
      : '标准：这个点的常规应用，两步左右'));
    L.push('');
    if (ctx.bankPrompt) L.push('题库里已经有这道题了：「' + clip(ctx.bankPrompt, 90) + '」，请换一个情境和数字，不要雷同。');
    if (ctx.avoid && ctx.avoid.length) {
      L.push('这一轮已经出过：');
      ctx.avoid.slice(-4).forEach(function (s) { L.push('- ' + clip(s, 70)); });
    }
    L.push('');
    L.push('【题型】只能二选一：');
    L.push('A 数值题 —— 答案是数、带单位的量或分数，学生直接输入，系统按数值比对。type="numeric"。');
    L.push('B 选择题 —— 3 或 4 个选项，只有一个正确。type="choice"。');
    L.push('概念辨析、说法对错这类天然不适合算数的点，用选择题；其余尽量用数值题。');
    L.push('');

    /* 探针：这是整套系统能「回溯定位」的前提，必须逼模型说清这道题卡在哪一步 */
    L.push('【探针：这道题卡在哪一步】');
    if (pre.length) {
      L.push('出完题再回答一句：这道题做错，最可能说明哪一步没掌握？只能选一个：');
      L.push('- 若这道题必须先用某个先修才能做对 → probe.id 填那个先修的 id，并且**让这道题只依赖这一个先修**，不要同时用上其它先修的难点；');
      L.push('- 若这道题只考本点、不需要任何先修 → probe.id 填本点 id（' + t.id + '）；');
      L.push('- 一道题只能指向一个 probe。不要出「先修 + 本点」都要绕几道弯的综合题，那样答错了也判不出断在哪。');
    } else {
      L.push('这个点在图谱里没有可测的先修，probe.id 一律填本点 id（' + t.id + '），step 写这道题具体在验哪一项。');
    }
    L.push('step 写这一步在做什么（不超过 14 字，例如「两位数乘法的进位」）；reason 写答错为什么能推出这一步没掌握（不超过 30 字）。');
    L.push('');
    L.push('【输出】只给 JSON，二选一：');
    L.push('{"type":"numeric","prompt":"题干","answer":"7","accept":["7 个","7个"],"probe":{"id":"' + (pre[0] ? pre[0].id : t.id) + '","step":"…","reason":"…"},"explanation":"30–80 字讲评：思路 + 常见错因"}');
    L.push('{"type":"choice","prompt":"题干","choices":[{"key":"A","text":"…"},{"key":"B","text":"…"}],"answer":"A","probe":{"id":"' + (pre[0] ? pre[0].id : t.id) + '","step":"…","reason":"…"},"explanation":"30–80 字讲评"}');
    L.push('accept 只放同一答案的常见写法（可省略）；题干里不要写「本题」「以下选项」，不要自带「答案：」。');
    return L.join('\n');
  }

  /* ---------------------------------------------------------------- 校验 */

  function normQuestion(obj, ctx) {
    if (!obj || typeof obj !== 'object') return null;
    var t = ctx.topic || {};
    var prompt = String(obj.prompt || obj.stem || '').replace(/\s+/g, ' ').trim();
    if (prompt.length < 6 || prompt.length > 320) return null;
    var type = String(obj.type || '').toLowerCase();
    var q = {
      id: 'ai_' + (t.id || 'x') + '_' + (ctx.attempt || 1) + '_' + Date.now().toString(36),
      topicId: t.id,
      difficulty: ctx.difficulty || 'standard',
      type: type,
      prompt: prompt,
      explanation: clip(obj.explanation || '', 200),
      ai: true
    };
    if (type === 'choice') {
      var cs = (obj.choices || []).slice(0, 5).map(function (c, i) {
        var key = String((c && c.key) || '').trim().toUpperCase() || 'ABCDE'.charAt(i);
        return { key: key, text: String((c && (c.text || c.value)) || '').trim() };
      }).filter(function (c) { return c.text; });
      if (cs.length < 2 || cs.length > 5) return null;
      var ans = String(obj.answer || '').trim().toUpperCase();
      if (!cs.some(function (c) { return c.key === ans; })) {
        /* 模型偶尔给下标 0/1/2 */
        var idx = parseInt(obj.answer, 10);
        if (!(idx >= 0 && idx < cs.length)) return null;
        ans = cs[idx].key;
      }
      q.choices = cs;
      q.answer = ans;
      return q;
    }
    if (type === 'numeric' || type === 'short' || type === 'answer') {
      q.type = type === 'numeric' ? 'numeric' : 'short';
      var a = String(obj.answer == null ? '' : obj.answer).trim();
      if (!a || a.length > 40) return null;
      q.answer = a;
      if (Array.isArray(obj.accept)) {
        var acc = obj.accept.map(function (x) { return String(x == null ? '' : x).trim(); })
          .filter(function (x) { return x && x !== a; }).slice(0, 4);
        if (acc.length) q.accept = acc;
      }
    } else {
      return null;
    }

    /* 探针：只能指向「本点」或「它在图谱里的某个可测先修」，指到别处就当没给。
       这一条决定了答错时能不能顺着先修往下追。 */
    var opts = ctx.probeOptions || [];
    var pr = obj.probe || {};
    var pid = String(pr.id || pr.topicId || '').trim();
    var hit = null;
    if (pid) {
      hit = opts.filter(function (p) { return p.id === pid || p.name === pid; })[0] || null;
    }
    if (hit) {
      /* step 里混进 id 是最常见的走样（「这一步：先修 cnm_p037」），清掉，空了就用点名字 */
      var step = clip(pr.step || '', 24).replace(/\b(?:cnm|cnc|cnp)_[A-Za-z0-9_]+\b/gi, '')
        .replace(/^(?:这一步|这一步是|step)\s*[:：]?\s*/i, '')
        .replace(/^[\s:：·-]+|[\s:：·-]+$/g, '')
        .trim();
      if (step.length <= 2) step = '';   // 只剩「先修」「这步」这种虚词，就用点名字
      q.probe = {
        id: hit.id,
        name: hit.name,
        step: step || hit.name,
        reason: clip(pr.reason || '', 60).replace(/\b(?:cnm|cnc|cnp)_[A-Za-z0-9_]+\b/gi, '').trim(),
        self: hit.id === t.id
      };
    }
    return q;
  }

  /* ---------------------------------------------------------------- 调用与缓存 */

  /* 本地持久缓存：出的题存进 localStorage，下次进来（换页、刷新、第二天）直接用，
     不再等模型。同一知识点留多个版本，「换一题」就是往前面插一个新的。 */
  var LS = 'cnmAI.q.v2';
  var PER_KEY = 5;      /* 同一个知识点最多留几个版本 */
  var TOTAL = 240;      /* 总共最多留几道，别把 localStorage 撑爆 */

  var mem = Object.create(null);   /* key -> { state, list, idx, err, at } */
  var modelCache = '';
  var inflight = Object.create(null);
  var fails = 0;      /* 连续失败次数：页面据此决定「这一轮先用题库」 */

  function keyOf(ctx) {
    var t = ctx.topic || {};
    return [t.id || '', ctx.attempt || 1, ctx.difficulty || ''].join('|');
  }

  var store = null;
  function readStore() {
    if (store) return store;
    try {
      var raw = JSON.parse(localStorage.getItem(LS));
      store = (raw && raw.v === 2 && raw.items && typeof raw.items === 'object') ? raw : { v: 2, items: {} };
    } catch (e) { store = { v: 2, items: {} }; }
    return store;
  }
  function saveStore() {
    if (!store) return;
    try {
      localStorage.setItem(LS, JSON.stringify(store));
    } catch (e) {
      /* 配额满了：砍掉一半再试一次，宁可少留几道也别让页面报错 */
      trimStore(0.5);
      try { localStorage.setItem(LS, JSON.stringify(store)); } catch (e2) { /* 放弃写入 */ }
    }
  }
  function trimStore(keepRatio) {
    var s = readStore();
    var flat = [];
    Object.keys(s.items).forEach(function (k) {
      s.items[k] = (s.items[k] || []).filter(function (it) { return it && it.q; });
      s.items[k].forEach(function (it) { flat.push({ k: k, it: it }); });
    });
    var want = Math.max(20, Math.floor(flat.length * keepRatio));
    if (flat.length <= want) return;
    flat.sort(function (a, b) { return (a.it.at || 0) - (b.it.at || 0); });
    flat.slice(0, flat.length - want).forEach(function (x) {
      var arr = s.items[x.k] || [];
      var i = arr.indexOf(x.it);
      if (i >= 0) arr.splice(i, 1);
      if (!arr.length) delete s.items[x.k];
    });
  }
  function storePut(k, q) {
    var s = readStore();
    var list = (s.items[k] || []).filter(function (it) { return it && it.q && it.q.prompt !== q.prompt; });
    list.unshift({ q: q, at: Date.now() });
    s.items[k] = list.slice(0, PER_KEY);
    trimStore(1);   /* 只做总量控制：超过 TOTAL 时按时间淘汰最旧的 */
    saveStore();
  }

  function view(e) {
    var list = (e && e.list) || [];
    var idx = Math.min(Math.max(0, (e && e.idx) || 0), Math.max(0, list.length - 1));
    return { state: e ? e.state : 'idle', q: list[idx] || null, list: list, idx: idx, err: (e && e.err) || '' };
  }

  function entryFor(ctx) {
    var k = keyOf(ctx);
    if (mem[k]) return mem[k];
    var saved = readStore().items[k];
    if (Array.isArray(saved) && saved.length) {
      mem[k] = {
        state: 'ok', idx: 0, err: '', at: saved[0].at || 0,
        list: saved.map(function (it) { return it.q; }).filter(Boolean)
      };
      return mem[k];
    }
    return null;
  }

  function modelId() {
    var L = llm();
    if (!L) return Promise.resolve('');
    if (L.isWeb()) return Promise.resolve('deepseek');
    if (modelCache) return Promise.resolve(modelCache);
    return L.listModels().then(function (list) {
      modelCache = L.pickDefault(list) || '';
      return modelCache;
    }).catch(function () { return ''; });
  }

  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        var e = new Error('模型超时');
        e.error = { code: 'timeout', message: '等太久了' };
        reject(e);
      }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  }

  function one(ctx) {
    var L = llm();
    if (!L) return Promise.reject(new Error('no-llm'));
    var system = SYSTEM;
    var user = buildPrompt(ctx);
    /* 先把转发地址定下来（同站 / 本机自动探测），再发请求，别拿一个连不上的地址去撞 */
    var settle = (L.ensureRelay ? L.ensureRelay() : Promise.resolve());
    return settle.then(function () { return modelId(); }).then(function (model) {
      if (!model) {
        var e = new Error('没有可用模型');
        e.error = { code: 'no_model', message: '没有可用模型' };
        throw e;
      }
      return withTimeout(L.complete({ model: model, system: system, user: user, temperature: 0.5 }), TIMEOUT);
    }).then(function (raw) {
      var obj = L.parseJson(raw);
      var q = normQuestion(obj, ctx);
      if (!q) {
        var e = new Error('题目格式不对');
        e.error = { code: 'ai_bad_json', message: '模型给的题不像一道题' };
        throw e;
      }
      return q;
    });
  }

  /* 预取 / 换一题：force=true 表示「再生成一题」，已有的版本会保留，新的插到最前。
     失败的不会自动重试（再点一次才会），否则每次渲染都打一次网络。 */
  function warm(ctx, done, force) {
    if (!ctx || !ctx.topic || !enabled()) return null;
    var k = keyOf(ctx);
    var e = entryFor(ctx);
    if (!e) e = mem[k] = { state: 'idle', list: [], idx: 0, err: '', at: 0 };

    if (!force && e.state === 'ok' && e.list.length) return view(e);   /* 有缓存，直接用 */
    if (!force && e.state === 'error') return view(e);                 /* 失败过，别自动重试 */

    if (inflight[k]) {
      if (done) inflight[k].then(function () { done(view(e)); }, function () { done(view(e)); });
      return view(e);
    }

    e.state = 'loading'; e.err = '';
    inflight[k] = one(ctx).then(function (q) {
      e.list = [q].concat((e.list || []).filter(function (x) { return x.prompt !== q.prompt; }));
      e.idx = 0; e.state = 'ok'; e.err = ''; e.at = Date.now();
      fails = 0;
      storePut(k, q);
      delete inflight[k];
      if (done) { try { done(view(e)); } catch (err) {} }
      return view(e);
    }, function (err) {
      e.state = 'error';
      e.err = (err && err.error && err.error.code) || String((err && err.message) || err);
      fails++;
      delete inflight[k];
      if (done) { try { done(view(e)); } catch (e2) {} }
      return view(e);
    });
    return view(e);
  }

  function peek(ctx) { return ctx ? view(entryFor(ctx)) : null; }
  /* 切到第 i 个版本（0 = 最新出的）。选中的提到最前并落盘，刷新后还是这一道。 */
  function pick(ctx, i) {
    if (!ctx) return null;
    var e = entryFor(ctx);
    if (!e || !e.list.length) return null;
    var idx = Math.min(Math.max(0, i | 0), e.list.length - 1);
    var chosen = e.list[idx];
    e.list = [chosen].concat(e.list.filter(function (x) { return x !== chosen; }));
    e.idx = 0;
    var k = keyOf(ctx);
    var s = readStore();
    var arr = (s.items[k] || []).filter(function (it) { return it && it.q && it.q.prompt !== chosen.prompt; });
    arr.unshift({ q: chosen, at: Date.now() });
    s.items[k] = arr;
    saveStore();
    return view(e);
  }
  function variants(ctx) {
    var e = ctx ? entryFor(ctx) : null;
    return e ? e.list.slice() : [];
  }
  function forget(ctx) { if (ctx) delete mem[keyOf(ctx)]; }
  function forgetFailed() {
    Object.keys(mem).forEach(function (k) { if (mem[k].state === 'error') delete mem[k]; });
  }
  function failsCount() { return fails; }
  function resetFails() { fails = 0; }
  function clear() { mem = Object.create(null); }

  /* 缓存里现在有多少道题（设置页/调试用） */
  function stats() {
    var ok = 0, bad = 0, saved = 0;
    Object.keys(mem).forEach(function (k) {
      if (mem[k].state === 'ok') ok++; else if (mem[k].state === 'error') bad++;
      saved += (mem[k].list || []).length;
    });
    var s = readStore();
    var onDisk = 0;
    Object.keys(s.items).forEach(function (k) { onDisk += (s.items[k] || []).length; });
    return { ok: ok, bad: bad, saved: saved, onDisk: onDisk };
  }

  window.CnmAIQ = {
    available: available, on: on, setOn: setOn, enabled: enabled,
    peek: peek, warm: warm, pick: pick, variants: variants,
    forget: forget, forgetFailed: forgetFailed, clear: clear, stats: stats,
    fails: failsCount, resetFails: resetFails,
    buildPrompt: buildPrompt, profileText: profileText, normQuestion: normQuestion,
    SYSTEM: SYSTEM
  };
})();
