/* 诊断小工具界面。核心逻辑全部在 engine.js，这里只负责数据加载、渲染与本地存储。 */
(function () {
  'use strict';
  const E = window.DiagEngine;
  const LS_SESSION = 'cnmDiagnose.session.v2';
  const LS_SESSION_EN = 'cneDiagnose.session.v2';
  const LS_SESSION_PHY = 'cnpDiagnose.session.v2';
  const LS_SESSION_ZH = 'cncDiagnose.session.v2';
  const LS_SEEN = 'cnmDiagnose.seen.v1';
  const GRADES = '一二三四五六七八九'.split('');
  const VOLUMES = [
    ['一上', '一年级上册'], ['一下', '一年级下册'], ['二上', '二年级上册'], ['二下', '二年级下册'],
    ['三上', '三年级上册'], ['三下', '三年级下册'], ['四上', '四年级上册'], ['四下', '四年级下册'],
    ['五上', '五年级上册'], ['五下', '五年级下册'], ['六上', '六年级上册'], ['六下', '六年级下册'],
    ['七上', '七年级上册'], ['七下', '七年级下册'], ['八上', '八年级上册'], ['八下', '八年级下册'],
    ['九上', '九年级上册'], ['九下', '九年级下册'], ['九全', '九年级全一册'],
    ['必修一', '必修一 · 必修第一册'], ['必修二', '必修二 · 必修第二册'], ['必修三', '必修三 · 必修第三册'],
    ['高一', '高一 · 必修第一册'], ['高二', '高二 · 必修第二册'],
    ['选必一', '选必一 · 选择性必修第一册'], ['选必二', '选必二 · 选择性必修第二册'],
    ['选必三', '选必三 · 选择性必修第三册'], ['选必四', '选必四 · 选择性必修第四册']
  ];
  const RESULT_LABEL = { correct: '对', wrong: '错', skip: '不会' };
  const STATUS_LABEL = { mastered: '已掌握', shaky: '不稳', weak: '薄弱', unknown: '未测' };
  const DIFF_LABEL = { basic: '基础', standard: '标准', advanced: '提高' };
  const TYPE_LABEL = { numeric: '数值题', choice: '选择题', short: '短答题', self: '开放题', legacy: '诊断题' };

  const root = document.getElementById('root');
  let D = null;            // 数据：{topics, deps, stdById, graph, tree}
  let session = null;      // 引擎会话
  let sessionMeta = null;  // {label, chapterKey?}
  let demo = null;         // 演示模式：{oracle}
  let ui = { key: null, phase: 'ask', answer: '', verdict: null };
  let subject = 'math';
  let startQuery = '';
  let startStage = '';
  let chapterOpen = true;
  let gradeSel = '七';     // 开始页「按年级诊断」：年级
  let volSel = '';         // '' 整年级 / '上' / '下'
  let rangeManual = false; // 用户手动改过年级/册次：此后不再跟随档案年级
  let startMode = new URLSearchParams(location.search).get('mode') === 'grade' ? 'grade' : 'single'; // 开始页当前模式
  let seedParam = null;    // URL 参数 seed：固定选题的随机种子
  let pathCy = null;
  let pathToken = 0;
  let pathTipLock = false;
  let pathExpanded = false;
  let finished = false;    // 用户主动结束本次诊断：不再出题，直接看结果
  const PATH_FOLD_AT = 40;
  let shareBlobUrl = null;
  let shareToken = 0;

  /* ------------------------------------------------------------ 小工具 */
  function h(tag, attrs) {
    const el = document.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach(function (k) {
      const v = a[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'open' || k === 'disabled' || k === 'selected' || k === 'value') el[k] = v === true ? true : v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function figureEl(svg) {
    if (typeof svg !== 'string' || svg.indexOf('<svg') !== 0) return null;
    if (/<\s*script|foreignObject|<\s*image\b|https?:\/\//i.test(svg.replace('xmlns="http://www.w3.org/2000/svg"', ''))) return null;
    const wrap = h('div', { class: 'q-figure' });
    wrap.innerHTML = svg;
    const node = wrap.querySelector('svg');
    if (!node) return null;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    return wrap;
  }
  function sessionKey() {
    if (subject === 'english') return LS_SESSION_EN;
    if (subject === 'physics') return LS_SESSION_PHY;
    if (subject === 'chinese') return LS_SESSION_ZH;
    return LS_SESSION;
  }
  function withSubject(href) {
    if (subject === 'math' || !href || href.indexOf('subject=') >= 0 || href.indexOf('http') === 0) return href;
    return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'subject=' + subject;
  }
  function detectSubject() {
    const params = new URLSearchParams(location.search);
    const explicit = params.get('subject');
    if (explicit === 'english' || explicit === 'math' || explicit === 'physics' || explicit === 'chinese') return explicit;
    const target = params.get('target') || '';
    let hashId = (location.hash || '').replace(/^#/, '');
    try { hashId = decodeURIComponent(hashId); } catch (e) { /* 保持原样 */ }
    if (/(^|,)\s*cne_/.test(target) || /^cne_/.test(hashId)) {
      params.set('subject', 'english');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'english';
    }
    if (/(^|,)\s*cnp_/.test(target) || /^cnp_/.test(hashId)) {
      params.set('subject', 'physics');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'physics';
    }
    if (/(^|,)\s*cnc_/.test(target) || /^cnc_/.test(hashId)) {
      params.set('subject', 'chinese');
      history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
      return 'chinese';
    }
    return 'math';
  }
  function applySubjectChrome() {
    document.body.classList.toggle('subject-english', subject === 'english');
    document.body.classList.toggle('subject-physics', subject === 'physics');
    document.body.classList.toggle('subject-chinese', subject === 'chinese');
    document.querySelectorAll('.site-nav a:not(.subject-link), a.brand').forEach(function (link) {
      const href = link.getAttribute('href');
      const next = withSubject(href);
      if (next && next !== href) link.setAttribute('href', next);
    });
    document.querySelectorAll('.subject-link').forEach(function (link) {
      const on = link.getAttribute('data-subject') === subject;
      link.classList.toggle('on', on);
      if (on) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
    if (subject === 'english') {
      document.title = '诊断 · 英语';
      var juniorOk = '三四五六七八九'.indexOf(gradeSel) >= 0;
      var seniorOk = gradeSel.indexOf('必修') === 0 || gradeSel.indexOf('选必') === 0;
      if (!juniorOk && !seniorOk) gradeSel = '四';
    }
    if (subject === 'physics') {
      document.title = '诊断 · 物理';
      if (gradeSel !== '八' && gradeSel !== '九' && !/^(必修[一二三]|选必[一二三])$/.test(gradeSel)) gradeSel = '八';
      if (gradeSel === '九') volSel = '全';
    }
    if (subject === 'chinese') {
      document.title = '诊断 · 小学语文';
      if ('一二三四五六'.indexOf(gradeSel) < 0) gradeSel = '一';
      if (volSel === '全') volSel = '';
    }
  }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式等 */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function nameOf(id) { const t = D.graph.byId[id]; return t ? t.name : id; }
  function seenList() { const v = lsGet(LS_SEEN); return Array.isArray(v) ? v : []; }
  function markSeen(qid) {
    if (!qid || demo) return;
    const v = seenList();
    if (v.indexOf(qid) < 0) { v.push(qid); lsSet(LS_SEEN, v); }
  }
  function newSeed() { return seedParam != null ? seedParam : Math.random().toString(36).slice(2, 10); }
  function resetUi() { ui = { key: null, phase: 'ask', answer: '', verdict: null, picked: null }; }
  function clearRoot() { while (root.firstChild) root.removeChild(root.firstChild); }
  function teardownPath() {
    pathToken++;
    pathTipLock = false;
    if (pathCy) { pathCy.destroy(); pathCy = null; window.__pathCy = null; }
  }
  function show(node) { teardownPath(); closeShare(); clearRoot(); node.classList.add('dx-stage'); root.append(node); window.scrollTo(0, 0); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function theme() {
    return {
      primary: cssVar('--node-primary'), primaryBg: cssVar('--node-primary-bg'),
      junior: cssVar('--node-junior'), juniorBg: cssVar('--node-junior-bg'),
      senior: cssVar('--node-senior'), seniorBg: cssVar('--node-senior-bg'),
      currentBg: cssVar('--node-current-bg'), currentBorder: cssVar('--node-current-border'),
      text: cssVar('--node-text'), edge: cssVar('--edge'), edgeSoft: cssVar('--edge-soft'),
      bad: cssVar('--diagram-bad'), badBg: cssVar('--diagram-bad-bg')
    };
  }
  function labelLimit() { return window.matchMedia('(max-width: 700px)').matches ? 8 : 10; }
  function clipLabel(name) {
    const chars = Array.from(name || '');
    const limit = labelLimit();
    if (chars.length <= limit) return name || '';
    return chars.slice(0, limit - 1).join('') + '…';
  }

  /* ------------------------------------------------------------ 数据 */
  async function loadData() {
    const urls = ['../data/topics.json', '../data/dependencies.json', '../data/cn-curriculum-standards.json', '../data/id-aliases.json'];
    const rs = await Promise.all(urls.map(function (u) { return fetch(u); }));
    rs.forEach(function (r, i) { if (!r.ok) throw new Error(urls[i] + ' → HTTP ' + r.status); });
    const js = await Promise.all(rs.map(function (r) { return r.json(); }));
    // 题库可选：缺失（404）或损坏时回退到 topics.json 的 diagnostic_question
    let questions = null;
    try {
      const qr = await fetch('../data/questions.json');
      if (qr.ok) questions = await qr.json();
    } catch (e) { questions = null; }
    const topics = js[0].filter(function (t) { return E.subjectOf(t) === subject; });
    const allow = {};
    topics.forEach(function (t) { allow[t.id] = true; });
    const deps = js[1].filter(function (d) { return allow[d.topicId] && allow[d.prerequisiteId]; });
    if (questions) questions = questions.filter(function (q) { return allow[q.topicId]; });
    const stdById = {};
    js[2].items.forEach(function (x) { stdById[x.id] = x; });
    const graph = E.buildGraph(topics, deps, questions);
    D = { topics: topics, deps: deps, stdById: stdById, graph: graph, tree: buildTree(topics), aliases: (js[3] && js[3].aliases) || {} };
  }

  function buildTree(topics) {
    const vols = {};
    topics.forEach(function (t) {
      if (t.external) return;
      const c = E.parseChapter(t.chapter);
      const v = vols[c.volume] || (vols[c.volume] = { chapters: [], byKey: {} });
      const key = c.chapterNo + ' ' + c.chapterName;
      let ch = v.byKey[key];
      if (!ch) {
        ch = v.byKey[key] = { volume: c.volume, key: c.volume + ' ' + c.chapterNo, label: c.chapterNo + ' ' + c.chapterName, topics: [] };
        v.chapters.push(ch);
      }
      ch.topics.push({ t: t, section: c.section });
    });
    return vols;
  }

  /* ------------------------------------------------------------ 孩子档案 */
  const CC = window.CnmChildren;
  function childLabel(c) { return c.name + (c.grade ? '（' + c.grade + '）' : ''); }
  function childrenHref(path) { return '../children/' + (path || ''); }
  function fromQuery() { return '?from=diagnose' + (subject !== 'math' ? '&subject=' + subject : ''); }
  function childSelect(onPick) {
    const cur = CC.current();
    const sel = h('select', { id: 'child-select', 'aria-label': '当前孩子' },
      h('option', { value: '' }, '不保存到档案'),
      CC.list().map(function (c) { return h('option', { value: c.id, selected: !!cur && cur.id === c.id }, childLabel(c)); }));
    sel.value = cur ? cur.id : '';
    sel.addEventListener('change', function () { onPick(sel.value || null); });
    return sel;
  }
  function childBar(mode) {
    if (demo) return null;
    const kids = CC.list();
    const cur = CC.current();
    if (!kids.length) {
      return h('div', { class: 'banner child-bar no-print', id: 'child-bar' },
        h('b', { text: '还没有孩子档案。' }),
        '添加后，诊断结果会按孩子保存，之后能回看每次的记录和薄弱知识点。', ' ',
        h('a', { class: 'btn btn-primary', href: childrenHref(fromQuery()), text: '添加孩子' }));
    }
    if (mode === 'question') {
      return h('div', { class: 'child-bar compact row no-print', id: 'child-bar' },
        h('span', { class: 'muted small' }, '当前孩子'),
        childSelect(function (id) { CC.setCurrent(id); }));
    }
    if (mode === 'result') {
      const key = recordKey();
      return h('div', { class: 'card child-bar no-print', id: 'child-bar' },
        h('p', { style: 'margin:0 0 8px' }, cur
          ? [h('b', { text: '已保存到「' + cur.name + '」的档案。' }), ' 换成别的孩子会把这条记录一起挪过去。']
          : [h('b', { text: '这次结果还没有存入档案。' }), ' 选一个孩子，就会保存。']),
        h('div', { class: 'row' },
          h('label', { for: 'child-select' }, '保存到'),
          childSelect(function (id) {
            if (cur && id !== cur.id) { if (id) CC.moveRecord(key, cur.id, id); else CC.removeRecord(cur.id, key); }
            CC.setCurrent(id);
            renderResult();
          }),
          cur ? h('a', { class: 'btn', href: childrenHref('history.html?child=' + encodeURIComponent(cur.id)), text: '打开档案' }) : null));
    }
    return h('div', { class: 'card child-bar no-print', id: 'child-bar' },
      h('div', { class: 'row' },
        h('label', { for: 'child-select' }, '当前孩子'),
        childSelect(function (id) { CC.setCurrent(id); rangeManual = false; renderStart(); })),
      cur ? h('div', { class: 'row dx-child-actions' },
        h('a', { class: 'btn', href: childrenHref('history.html?child=' + encodeURIComponent(cur.id)), text: '打开档案' })) : null,
      h('p', { class: 'muted small', style: 'margin:8px 0 0' },
        cur ? '诊断做完，结果会保存到「' + cur.name + '」的档案里。' : '选了“不保存到档案”时，诊断结果不会存下来。'));
  }
  function recordKey() { return [subject, session.seed, session.targets.join(',')].join('|'); }
  function saveToChild(sum, partial) {
    const cur = CC.current();
    if (demo || !cur || !sum.asked) return;
    CC.saveRecord(cur.id, {
      key: recordKey(), subject: subject, label: sessionMeta.label, mode: sum.mode, asked: sum.asked,
      partial: !!partial,
      targets: sum.mode === 'screen' || sum.targets.length > 6 ? null : sum.targets,
      counts: { weak: sum.weak.length, shaky: sum.shaky.length, mastered: sum.mastered.length, untested: sum.untested.length },
      weak: sum.weak, roots: sum.roots.map(function (r) { return r.id; }), shaky: sum.shaky, mastered: sum.mastered
    });
  }

  /* ------------------------------------------------------------ 会话 */
  function save() {
    if (demo || !session) return;
    lsSet(sessionKey(), {
      v: 3, mode: session.mode, targets: session.targets, base: session.base || [], finished: !!finished,
      open: !!session.open, limit: isFinite(session.limit) ? session.limit : 0,
      label: sessionMeta.label, answers: session.answers,
      seed: session.seed, avoid: session.avoid, savedAt: new Date().toISOString()
    });
  }

  function startSession(targets, label, mode, base) {
    pathExpanded = false;
    finished = false;
    session = E.createSession(D.graph, targets, {
      mode: mode, open: true,
      base: mode === 'screen' ? base : null, seed: newSeed(), avoid: seenList()
    });
    sessionMeta = { label: label };
    resetUi();
    save();
    render();
  }

  function restoreSession(saved) {
    try {
      session = E.replay(D.graph, saved.targets, saved.answers, {
        mode: saved.mode, seed: saved.seed, avoid: saved.avoid, base: saved.base,
        open: saved.open !== false, limit: saved.limit || null
      });
      sessionMeta = { label: saved.label || saved.targets.map(nameOf).join('、') };
      finished = !!saved.finished;
      return true;
    } catch (e) { return false; }
  }

  function restart() {
    pathExpanded = false;
    session = null; demo = null;
    lsDel(sessionKey());
    history.replaceState(null, '', location.pathname + (subject !== 'math' ? '?subject=' + subject : ''));
    render();
  }

  function commit(result) {
    const item = E.nextItem(D.graph, session);
    session = E.applyAnswer(D.graph, session, item.topicId, result, { text: ui.answer });
    markSeen(item.question.id);
    resetUi();
    save();
    // 边答边记：随时中断、随时关页面都不丢
    try { saveToChild(E.summarize(D.graph, session), true); } catch (e) { /* 记录失败不影响答题 */ }
    render();
  }

  function rebuild(answers, limit) {
    session = E.replay(D.graph, session.targets, answers, {
      mode: session.mode, seed: session.seed, avoid: session.avoid, base: session.base,
      open: session.open !== false, limit: limit == null ? null : limit
    });
    finished = false;
    resetUi();
    save();
    render();
  }

  /* ------------------------------------------------------------ 演示模式 */
  // 演示用的“学生”：目标不会（错、错 -> 薄弱）；它的第一个可测先修也不会；再往前（或另一个先修）答错一次、第二题答对 -> 不稳；其余都会
  function makeOracle(targets, mode) {
    const G = D.graph;
    if (mode === 'screen') {
      // 整体筛查：按知识点序号，约 1/6 不会、1/6 不稳，其余都会（与 scripts/demo_grade.js 相同）
      return function (id, attempt) {
        const i = G.index[id];
        if (i % 6 === 0) return 'wrong';
        if (i % 6 === 3) return attempt === 1 ? 'wrong' : 'correct';
        return 'correct';
      };
    }
    const t0 = E.createSession(G, targets).stack[0];
    const testablePre = function (id) { return G.prereqs[id].filter(function (x) { return E.isTestable(G, x.id); }).map(function (x) { return x.id; }); };
    const weak = new Set([t0]);
    const shaky = new Set();
    const p = testablePre(t0);
    if (p.length) {
      const q = testablePre(p[0]);
      if (q.length) { weak.add(p[0]); shaky.add(q[0]); }
      else if (p.length > 1) { weak.add(p[0]); shaky.add(p[1]); }
      else shaky.add(p[0]);
    }
    return function (id, attempt) {
      if (weak.has(id)) return 'wrong';
      if (shaky.has(id)) return attempt === 1 ? 'wrong' : 'correct';
      return 'correct';
    };
  }

  function runDemo(steps) {
    let n = 0;
    while (n < steps) {
      const item = E.nextItem(D.graph, session);
      if (!item) break;
      session = E.applyAnswer(D.graph, session, item.topicId, demo.oracle(item.topicId, item.attempt));
      n++;
    }
  }

  /* ------------------------------------------------------------ 渲染入口 */
  function render() {
    if (!session) return renderStart();
    if (finished) return renderResult();
    const item = E.nextItem(D.graph, session);
    if (item) renderQuestion(item); else renderResult();
  }

  /* 随时结束：保留已答的记录，直接进结果页 */
  function endNow() {
    if (!session || !session.answers.length) return;
    finished = true;
    save();
    render();
  }

  /* ------------------------------------------------------------ 开始页 */
  function stageButton(value, label) {
    return h('button', {
      type: 'button',
      class: 'stage-tab' + (startStage === value ? ' on' : ''),
      role: 'tab',
      'aria-selected': startStage === value ? 'true' : 'false',
      onclick: function () { startStage = value; renderStart(); }
    }, label);
  }

  /* 开始页的 KPI 小卡 */
  function dxKpi(label, value, unit, meta, cls) {
    const box = h('div', { class: 'pt-kpi ' + (cls || '') });
    const lab = h('div', { class: 'pt-kpi-label' });
    lab.append(h('i', { class: 'pt-dot' }));
    lab.append(document.createTextNode(label));
    box.append(lab);
    box.append(h('div', { class: 'pt-kpi-value' }, String(value), unit ? h('small', null, unit) : null));
    box.append(h('div', { class: 'pt-kpi-meta', text: meta || '' }));
    return box;
  }

  function renderStart(errMsg) {
    const page = h('div', { class: 'dx-start ' + (startMode === 'grade' ? 'is-grade' : 'is-single') });
    const saved = lsGet(sessionKey());
    if (saved && saved.targets && D.graph.byId[saved.targets[0]]) {
      page.append(h('div', { class: 'banner' },
        h('b', { text: '有一份未清除的诊断：' }), saved.label || saved.targets.map(nameOf).join('、'),
        '（已答 ' + (saved.answers || []).length + ' 题）　',
        h('button', { class: 'primary', onclick: function () { if (restoreSession(saved)) render(); else { lsDel(sessionKey()); renderStart('存档无法恢复，已清除。'); } } }, '继续'),
        ' ', h('button', { onclick: function () { lsDel(sessionKey()); renderStart(); } }, '放弃存档')));
    }
    if (errMsg) page.append(h('p', { class: 'err', text: errMsg }));

    const cur = CC.current();
    const subjects = { math: '数学', chinese: '语文', english: '英语', physics: '物理' };

    /* 年级模式：范围默认跟着档案里的年级走；没有档案孩子（含演示）时才用手动范围 */
    if (startMode === 'grade') {
      if (demo || !childScopeOf(cur && cur.grade)) rangeManual = true;
      followChildGrade();
    }

    /* ---- 页面头 ---------------------------------------------------------- */
    page.append(h('div', { class: 'shell-head no-print' },
      h('div', { class: 'shell-head-main' },
        h('h1', null, '诊断'),
        h('p', { class: 'shell-sub' }, startMode === 'grade'
          ? '范围跟着档案里的年级走，上下册一起看，只差一样要你选：科目。答错往回追一层，低年级基础只在用到时才问。'
          : '先问目标本身。答错再出一道同级或更容易的题，仍然错才沿先修往回追，最后按年级排出补学顺序。')),
      h('div', { class: 'shell-head-actions' },
        h('a', { class: 'btn', href: childrenHref(fromQuery()) }, '孩子档案'))));

    /* ---- KPI ------------------------------------------------------------- */
    const recs = cur ? CC.recordsOf(cur.id) : [];
    page.append(h('div', { class: 'pt-kpis' },
      dxKpi('可诊断知识点', D.topics.length, '个', subjects[subject] + ' · 当前学科', 'is-blue'),
      dxKpi('先修关系', D.deps.length, '条', '用于问答式回溯', 'is-blue'),
      dxKpi('当前孩子', cur ? cur.name : '未选择', '', cur ? ([cur.grade, cur.textbook].filter(Boolean).join(' · ') || '结果会存进档案') : '结果不会存进档案', cur ? 'is-green' : 'is-amber'),
      dxKpi('已完成诊断', recs.length, '次', recs.length ? '可在档案里回看' : '还没有记录', 'is-amber')));

    /* ---- 模式切换 -------------------------------------------------------- */
    page.append(h('div', { class: 'dx-modes-wrap no-print' },
      h('div', { class: 'pt-seg dx-modes', role: 'tablist', 'aria-label': '诊断方式' },
        [['single', '单点诊断'], ['grade', '按年级诊断']].map(function (m) {
          return h('button', {
            type: 'button', role: 'tab',
            class: startMode === m[0] ? 'on' : '',
            'aria-selected': startMode === m[0] ? 'true' : 'false',
            onclick: function () { if (startMode !== m[0]) { startMode = m[0]; renderStart(); } }
          }, m[1]);
        }))));

    const mainCol = h('div', { class: 'dx-main' });
    const sideCol = h('aside', { class: 'dx-side' });
    page.append(h('div', { class: 'dx-cols' }, mainCol, sideCol));

    /* 当前孩子：属于全局上下文，统一放在侧栏顶部（按年级模式已在主卡上给选择器，不重复） */
    const kidBar = childBar('start');
    if (kidBar && startMode !== 'grade') sideCol.append(kidBar);


    if (startMode === 'single') {
      const listBox = h('div', { id: 'target-list' });
      const browser = h('details', { class: 'chapter-browser', id: 'chapter-browser', open: chapterOpen },
        h('summary', null, '按册、章浏览'),
        h('p', { class: 'muted small', text: '列表按年级、册、章折叠。想直接开始，用上面的搜索更快。' }),
        listBox);
      browser.addEventListener('toggle', function () { chapterOpen = browser.open; });

      mainCol.append(h('section', { class: 'pt-panel dx-panel-pick' },
        h('div', { class: 'pt-panel-head' },
          h('h2', null, '选一个知识点'),
          h('span', { class: 'pt-pill is-gray', id: 'match-count' }, '')),
        h('div', { class: 'pt-panel-body' },
          h('div', { class: 'stage-tabs', role: 'tablist', 'aria-label': '学段' },
            subject === 'physics' ? [stageButton('', '全部'), stageButton('j', '初中'), stageButton('h', '高中')]
              : subject === 'chinese' ? [stageButton('', '全部'), stageButton('p', '小学')]
              : [stageButton('', '全部'), stageButton('p', '小学'), stageButton('j', '初中'), stageButton('h', '高中')]),
          h('input', {
            type: 'search', class: 'search-lg', id: 'search',
            placeholder: subject === 'physics' ? '搜索知识点，例如：欧姆定律、浮力、牛顿第二定律、楞次定律' : subject === 'english' ? '搜索知识点，例如：现在进行时、虚拟语气、there is' : subject === 'chinese' ? '搜索知识点，例如：声母、静夜思、的地得' : '搜索知识点，例如：配方法、20 以内加法、一次函数',
            value: startQuery, autocomplete: 'off', 'aria-label': '搜索知识点',
            oninput: function (e) {
              startQuery = e.target.value;
              fillList(listBox);
              if (startQuery.trim()) { browser.open = true; chapterOpen = true; }
            }
          }),
          browser)));

      /* 侧栏：怎么开始 + 提示 */
      sideCol.append(h('section', { class: 'pt-panel dx-side-card' },
        h('div', { class: 'pt-panel-head' },
          h('h2', null, '怎么开始'),
          h('span', { class: 'pt-pill is-blue' }, '单点')),
        h('div', { class: 'pt-panel-body' },
          h('p', { class: 'dx-note' }, '点任意知识点的「选为目标」就直接开始，不用再确认。每个知识点最多问 2 题，答完自动出结果。'),
          h('p', { class: 'dx-note' }, '中途想停就点右上角「结束」，已经答的题会照常记进档案。'),
          h('div', { class: 'dx-start-hint' },
            h('svg', { viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
              h('path', { d: 'M12 3v9' }), h('circle', { cx: '12', cy: '16.4', r: '1.1', fill: 'currentColor', stroke: 'none' }), h('circle', { cx: '12', cy: '12', r: '9' })),
            h('span', null, '不设题量，随时可以停。')))));

    } else {
      mainCol.append(gradeCard(sideCol));
    }

    /* 左栏底部：结果怎么读。主区比侧栏宽，横排一行看得完 */
    mainCol.append(h('section', { class: 'pt-panel dx-side-card dx-legend-card' },
      h('div', { class: 'pt-panel-head' }, h('h2', null, '结果怎么读')),
      h('div', { class: 'pt-panel-body' },
        h('ul', { class: 'dx-legend' },
          h('li', null, h('span', { class: 'pt-pill is-green' }, '掌握'), h('span', null, '第一题就答对')),
          h('li', null, h('span', { class: 'pt-pill is-amber' }, '不稳'), h('span', null, '第二题才答对')),
          h('li', null, h('span', { class: 'pt-pill is-red' }, '薄弱'), h('span', null, '两道题都没答对')),
          h('li', null, h('span', { class: 'pt-pill is-gray' }, '未测'), h('span', null, '还没问到的'))))));

    show(page);
    if (startMode === 'single') {
      fillList(document.getElementById('target-list'));
      if (startQuery) { const el = document.getElementById('search'); if (el) el.focus(); }
    }
  }

  function seniorGrade(sel) {
    return sel === '高一' || sel === '高二' || String(sel).indexOf('选必') === 0 || String(sel).indexOf('必修') === 0;
  }
  function seniorRangeLabel(sel) { return String(sel).indexOf('选必') === 0 ? '整册' : '必修整册'; }
  function gradeScope() {
    if (seniorGrade(gradeSel)) return gradeSel;
    if (subject === 'physics' && gradeSel === '九') return '九全';
    if (subject === 'english' && gradeSel === '九') return volSel === '上' ? '九上' : (volSel === '全' ? '九全' : '九年级');
    return gradeSel + (volSel ? volSel : '年级');
  }

  const SUBJECT_NAME = { math: '数学', english: '英语', physics: '物理', chinese: '语文' };

  /* 档案里的年级 → engine 的 scope 键。映射不上的（高三 / 空）返回 ''，交给手动选择。 */
  function childScopeOf(g) {
    const s = String(g || '').trim();
    if (/^[一二三四五六七八九]年级$/.test(s)) return s;
    if (s === '高一' || s === '高二') return s;
    return '';
  }

  /* 把 gradeSel / volSel 对齐到当前孩子的年级。返回是否发生了变化。 */
  function followChildGrade() {
    if (rangeManual) return false;
    const cur = CC.current();
    const key = childScopeOf(cur && cur.grade);
    if (!key) return false;
    let changed = false;
    if (seniorGrade(key)) {
      if (gradeSel !== key) { gradeSel = key; changed = true; }
      if (volSel !== '') { volSel = ''; changed = true; }
      return changed;
    }
    const g1 = key.charAt(0);
    if (gradeSel !== g1) { gradeSel = g1; changed = true; }
    const want = (subject === 'physics' && g1 === '九') ? '全' : '';
    if (volSel !== want) { volSel = want; changed = true; }
    return changed;
  }

  /* 换科目：走 URL 参数，和全站学科切换保持一致 */
  function switchSubject(next) {
    const p = new URLSearchParams(location.search);
    if (next === 'math') p.delete('subject'); else p.set('subject', next);
    p.delete('target');
    p.delete('demo');
    p.set('mode', 'grade');
    location.href = location.pathname + '?' + p.toString();
  }

  /* 册次键 → 中文名（四上 → 四年级上册） */
  function volLabel(v) {
    for (let i = 0; i < VOLUMES.length; i++) if (VOLUMES[i][0] === v) return VOLUMES[i][1];
    return v;
  }

  /* 该科目下可选年级：和 engine 里的册次命名对齐 */
  function gradeOptions(subj) {
    if (subj === 'physics') {
      return [['八', '八年级'], ['九', '九年级'], ['必修一', '必修一'], ['必修二', '必修二'], ['必修三', '必修三'],
        ['选必一', '选必一'], ['选必二', '选必二'], ['选必三', '选必三']];
    }
    if (subj === 'english') {
      return '三四五六七八九'.split('').map(function (x) { return [x, x + '年级']; }).concat([
        ['必修一', '必修一'], ['必修二', '必修二'], ['必修三', '必修三'],
        ['选必一', '选必一'], ['选必二', '选必二'], ['选必三', '选必三'], ['选必四', '选必四']]);
    }
    if (subj === 'chinese') {
      return '一二三四五六'.split('').map(function (x) { return [x, x + '年级']; });
    }
    return GRADES.map(function (x) { return [x, x + '年级']; }).concat([
      ['高一', '高一'], ['高二', '高二'], ['选必一', '选必一'], ['选必二', '选必二'], ['选必三', '选必三']]);
  }


  // 基础池覆盖到哪些年级：连续年级并成「一年级–三年级」，跨学段用「、」分开
  function baseGradeLabel(grades) {
    if (!grades || !grades.length) return '';
    const segs = [];
    let start = grades[0], prev = grades[0];
    for (let i = 1; i < grades.length; i++) {
      if (grades[i] === prev + 1) { prev = grades[i]; continue; }
      segs.push([start, prev]);
      start = prev = grades[i];
    }
    segs.push([start, prev]);
    return segs.map(function (s) {
      return s[0] === s[1] ? gradeWord(s[0]) : gradeWord(s[0]) + '–' + gradeWord(s[1]);
    }).join('、');
  }

  function gradeCard(sideCol) {
    const box = h('section', { class: 'pt-panel', id: 'grade-card' });
    let sideMount = null;   // 侧栏槽位：用闭包持有，避免在未入文档时查不到

    /* 科目分段：切 URL，和全站学科切换保持一致 */
    const subjectSeg = function () {
      return h('div', { class: 'pt-seg dx-subjects', role: 'tablist', 'aria-label': '科目' },
        ['math', 'english', 'physics', 'chinese'].map(function (k) {
          return h('button', {
            type: 'button', role: 'tab', class: subject === k ? 'on' : '',
            'aria-selected': subject === k ? 'true' : 'false',
            onclick: function () { if (subject !== k) switchSubject(k); }
          }, SUBJECT_NAME[k]);
        }));
    };

    const tabs = function (label, items, current, set) {
      return h('div', { class: 'stage-tabs', role: 'tablist', 'aria-label': label }, items.map(function (it) {
        return h('button', {
          type: 'button', class: 'stage-tab' + (current === it[0] ? ' on' : ''), role: 'tab',
          'aria-selected': current === it[0] ? 'true' : 'false', 'data-value': it[0],
          onclick: function () { set(it[0]); fill(); }
        }, it[1]);
      }));
    };

    const fill = function () {
      while (box.firstChild) box.removeChild(box.firstChild);
      const cur = CC.current();
      const kidGrade = cur && cur.grade ? cur.grade : '';
      const autoKey = childScopeOf(kidGrade);
      const auto = !!autoKey && !rangeManual;
      const g = E.gradeTargets(D.graph, gradeScope(), subject, { cumulative: true });
      const baseGrades = g && g.base.length ? baseGradeLabel(g.baseGrades) : '';
      const volText = g ? (g.volumes.length === 1 ? '全一册' : '上下册') : '';

      box.append(
        h('div', { class: 'pt-panel-head' },
          h('h2', null, '按年级诊查'),
          h('span', { class: 'pt-pill ' + (auto ? 'is-green' : 'is-gray'), id: 'grade-info' },
            auto ? '跟随档案年级' : '手动指定')),
        h('div', { class: 'pt-panel-body' },
          /* 当前孩子 · 范围来源 */
          h('div', { class: 'dx-childline' + (cur ? '' : ' is-empty') },
            h('span', { class: 'dx-childline-label' }, '当前孩子'),
            CC.list().length
              ? childSelect(function (id) { CC.setCurrent(id); rangeManual = false; renderStart(); })
              : h('a', { class: 'dx-childline-link', href: childrenHref(fromQuery()), text: '去建档' }),
            cur
              ? h('span', { class: 'dx-childline-save', text: '结果存进「' + cur.name + '」的档案' })
              : h('span', { class: 'dx-childline-hint', text: '没有档案孩子时，范围只能手动指定' })),

          /* 科目 */
          h('div', { class: 'dx-tabblock' },
            h('span', { class: 'dx-tablabel' }, '科目'),
            subjectSeg()),

          /* 自动范围 */
          h('div', { class: 'dx-autoscope' },
            h('div', { class: 'dx-autoscope-main' },
              h('span', { class: 'dx-autoscope-grade' },
                g ? g.label + (volText ? '（' + volText + '）' : '') : '这个范围没有知识点'),
              g ? h('span', { class: 'dx-autoscope-n', text: g.ids.length + ' 个知识点' }) : null),
            g && g.byVolume && g.byVolume.length > 1
              ? h('p', { class: 'dx-autoscope-vols' },
                g.byVolume.map(function (v) { return volLabel(v.volume) + ' ' + v.n + ' 个'; }).join(' · '))
              : null,
            g && g.base.length
              ? h('p', { class: 'dx-autoscope-sub' },
                '往下兜底：' + baseGrades + ' 的 ' + g.base.length + ' 个基础点，只在答错时回查，不重复考简单题')
              : null,
            h('p', { class: 'dx-autoscope-note' }, auto
              ? '跟着「' + cur.name + '」的档案年级走，档案里改了年级，这里立刻跟着变。'
              : '当前是手动指定的范围，不会跟随档案年级。')),

          /* 手动调整 */
          h('details', { class: 'dx-advance', open: !auto },
            h('summary', null, '调整范围'),
            h('div', { class: 'dx-tabblock' },
              h('span', { class: 'dx-tablabel' }, '年级'),
              tabs('年级', gradeOptions(subject), gradeSel, function (v) {
                rangeManual = true;
                gradeSel = v;
                if (seniorGrade(v)) volSel = '';
                else if (subject === 'physics' && v === '九') volSel = '全';
                else if (subject === 'english' && v === '九') volSel = '';
                else if (volSel === '全') volSel = '';
              })),
            h('div', { class: 'dx-tabblock' },
              h('span', { class: 'dx-tablabel' }, '册次'),
              seniorGrade(gradeSel)
                ? tabs('册次', [['', seniorRangeLabel(gradeSel)]], '', function () { rangeManual = true; volSel = ''; })
                : (subject === 'physics' && gradeSel === '九')
                  ? tabs('册次', [['全', '全一册']], '全', function () { rangeManual = true; volSel = '全'; })
                  : (subject === 'english' && gradeSel === '九')
                    ? tabs('册次', [['', '整年级'], ['上', '上册（新版）'], ['全', '全一册（旧版，九下暂用）']], volSel, function (v) { rangeManual = true; volSel = v; })
                    : tabs('册次', [['', '整学年（上下册）'], ['上', '只上册'], ['下', '只下册']], volSel, function (v) { rangeManual = true; volSel = v; })),
            autoKey
              ? h('button', {
                type: 'button', class: 'dx-advance-reset',
                onclick: function () { rangeManual = false; followChildGrade(); fill(); }
              }, '恢复跟随档案年级')
              : null)));

      if (!sideCol) return;
      if (!sideMount) {
        sideMount = h('div', { id: 'grade-side', class: 'dx-side-slot' });
        sideCol.append(sideMount);
      }
      while (sideMount.firstChild) sideMount.removeChild(sideMount.firstChild);
      sideMount.append(h('section', { class: 'pt-panel dx-side-card' },
        h('div', { class: 'pt-panel-head' },
          h('h2', null, '本次范围'),
          h('span', { class: 'pt-pill is-blue' }, auto ? '跟随档案' : '手动指定')),
        h('div', { class: 'pt-panel-body' },
          h('p', { class: 'dx-scope' },
            h('strong', null, g ? g.label + (volText ? '（' + volText + '）' : '') : '这个范围没有知识点'),
            g
              ? h('span', null, g.ids.length + ' 个本年级知识点' + (g.base.length ? '，连带 ' + g.base.length + ' 个过往基础点' : ''))
              : h('span', null, '换一个科目或年级再试'),
            baseGrades ? h('span', { class: 'dx-scope-sub' }, '基础范围：' + baseGrades + ' · 只在答错时回查，不单独占题量') : null),
          h('button', {
            class: 'primary dx-start-btn', id: 'btn-grade-start', disabled: !g,
            onclick: function () { if (g) startSession(g.ids, g.label + '（年级诊断）', 'screen', g.base); }
          }, g ? '开始「' + g.label + '」诊断' : '开始诊断'),
          h('p', { class: 'dx-note' }, '不设题量，一直往下问，想停就点右上角「结束」。答错或不稳时会往回追一层，追到低年级基础就顺手查掉；结果随时记进档案。'))));
    };
    fill();
    return box;
  }

  function fillList(box) {
    while (box.firstChild) box.removeChild(box.firstChild);
    const q = startQuery.trim().toLowerCase();
    let shown = 0;
    function volumeStage(key) {
      if (key === '高一' || key === '高二' || key.indexOf('选必') === 0 || key.indexOf('必修') === 0) return 'h';
      if ('一二三四五六'.indexOf(key.charAt(0)) >= 0) return 'p';
      return 'j';
    }
    VOLUMES.forEach(function (vv) {
      if (startStage && volumeStage(vv[0]) !== startStage) return;
      const v = D.tree[vv[0]];
      if (!v) return;
      const chapters = [];
      v.chapters.forEach(function (ch) {
        const chHit = q && ch.label.toLowerCase().indexOf(q) >= 0;
        const rows = ch.topics.filter(function (x) {
          if (!q || chHit) return true;
          return (x.t.name + ' ' + x.t.description + ' ' + x.t.chapter).toLowerCase().indexOf(q) >= 0;
        });
        if (rows.length) chapters.push({ ch: ch, rows: rows });
      });
      if (!chapters.length) return;
      const count = chapters.reduce(function (n, c) { return n + c.rows.length; }, 0);
      shown += count;
      const openVol = subject === 'physics' ? '八上' : subject === 'english' ? '三上' : '一上';
      const seniorOpen = subject === 'english' || subject === 'physics' ? '必修一' : '高一';
      const det = h('details', { class: 'vol', open: !!q || (startStage === 'j' ? vv[0] === '七上' : startStage === 'h' ? vv[0] === seniorOpen : vv[0] === openVol) },
        h('summary', null, vv[1] + '（' + count + ' 个知识点）'));
      chapters.forEach(function (c) {
        const ch = c.ch;
        det.append(h('div', { class: 'chap' },
          h('div', { class: 'chap-head' },
            h('span', { class: 't', text: ch.label }),
            h('button', {
              class: 'primary', title: '把本章全部 ' + ch.topics.length + ' 个知识点一起作为目标',
              onclick: function () { startSession(ch.topics.map(function (x) { return x.t.id; }), ch.volume + ' ' + ch.label + '（整章）'); }
            }, '以整章为目标')),
          c.rows.map(function (x) {
            return h('div', { class: 'topic-row', title: x.t.description },
              h('span', { class: 'nm', text: x.t.name }),
              h('span', { class: 'sec', text: x.section }),
              h('button', { onclick: function () { startSession([x.t.id], x.t.name); } }, '选为目标'));
          })));
      });
      box.append(det);
    });
    if (!shown) box.append(h('p', { class: 'muted', text: '没有匹配的知识点。' }));
    const mc = document.getElementById('match-count');
    if (mc) mc.textContent = (q ? '找到 ' : '共 ') + shown + ' 个';
    const browser = document.getElementById('chapter-browser');
    if (browser && q) browser.open = true;
  }

  /* ------------------------------------------------------------ 出题页 */
  function reasonFor(item) {
    const id = item.topicId;
    if (item.attempt === 2) return '第一题没答对，再出一道' + (item.question.difficulty === 'basic' ? '更基础' : '同级或更容易') + '的题确认：这一题也错才算薄弱，答对则标为「不稳」。';
    for (let i = session.answers.length - 1; i >= 0; i--) {
      const a = session.answers[i];
      if (a.result === 'correct') continue;
      const p = D.graph.prereqs[a.id].find(function (x) { return x.id === id; });
      if (p && E.statusOf(session, a.id) === 'weak') return '因为「' + nameOf(a.id) + '」两题都没通过，现在检查它的' + (p.strength === 'hard' ? '硬' : '软') + '先修知识点。';
    }
    if (session.mode === 'screen') return '年级诊断：在当前年级的范围里随机抽一个还没测过的知识点，答对会连带跳过它的先修。';
    if (session.targets.length > 1) return '这是所选章节里的知识点，随机抽一个还没测过的（答对会连带跳过它的先修）。';
    return session.targets.indexOf(id) >= 0 ? '这是你选择的目标知识点，先从它开始测。' : '检查目标的先修知识点。';
  }

  function judgeAndGo(item) {
    const q = item.question;
    const val = ui.answer.trim();
    if (!val) { const el = document.getElementById('ans'); if (el) el.focus(); return; }
    const r = E.judgeQuestion(q, val);
    ui.verdict = r;
    ui.phase = r.verdict === 'manual' ? 'self' : 'auto';
    renderQuestion(item);
  }

  function answerText(q) {
    if (q.type === 'choice') {
      const c = (q.choices || []).find(function (x) { return x.key === q.answer; });
      return q.answer + (c ? '. ' + c.text : '');
    }
    return q.answer;
  }

  function feedbackBlock(q) {
    return h('div', { class: 'feedback' },
      h('div', { class: 'refans' }, h('b', null, '参考答案：'), answerText(q)),
      q.explanation ? h('div', { class: 'explain', id: 'explain' }, h('b', null, '解析：'), q.explanation) : null);
  }

  function renderQuestion(item) {
    const id = item.topicId;
    const q = item.question;
    const t = D.graph.byId[id];
    const key = id + '#' + item.attempt;
    if (ui.key !== key) ui = { key: key, phase: 'ask', answer: '', verdict: null, picked: null };
    const n = session.answers.length;
    const baseSet = new Set(session.base || []);
    const seen = Object.keys(session.attempts).filter(function (k) { return !baseSet.has(k); }).length;
    const total = session.stack.length || 1;
    const pct = Math.min(100, Math.round(seen / total * 100));
    const card = h('div', { class: 'card' });
    card.append(
      h('div', { class: 'row q-head' },
        h('span', { class: 'muted q-head-label' }, '范围：' + sessionMeta.label),
        h('span', { class: 'grow' }),
        h('span', { class: 'muted q-progress-num', id: 'q-progress' }, '已测 ' + seen + ' / ' + total + ' 个'),
        h('button', { class: 'q-end', id: 'btn-end', title: '保留已答的记录，直接出结果', onclick: endNow }, '结束')),
      h('div', { class: 'progress' }, h('i', { style: 'width:' + pct + '%' })),
      h('h2', { class: 'q-title' }, t.name, ' ', h('span', { class: 'tag', text: t.chapter })),
      h('div', { class: 'row small', style: 'margin:2px 0' },
        h('span', { class: 'tag diff-' + q.difficulty, text: DIFF_LABEL[q.difficulty] || q.difficulty }),
        h('span', { class: 'tag', text: TYPE_LABEL[q.type] || q.type }),
        h('span', { class: 'tag', text: '本知识点第 ' + item.attempt + ' 题' })),
      h('div', { class: 'reason', text: reasonFor(item) }),
      h('div', { class: 'q-text', id: 'q-text', text: q.prompt }));
    const stemFig = figureEl(q.figure);
    if (stemFig) {
      const qt = card.querySelector('#q-text');
      if (qt) qt.insertAdjacentElement('afterend', stemFig);
    }

    if (ui.phase === 'ask') {
      if (q.type === 'choice') {
        card.append(h('div', { class: 'choices' + (q.hideChoiceText ? ' fig-icons' : ''), id: 'choices' }, (q.choices || []).map(function (c) {
          const hideName = !!(q.hideChoiceText && c.figure);
          const kids = [h('b', { class: 'choice-key', text: hideName ? c.key : (c.key + '.') })];
          if (!hideName) kids.push(document.createTextNode(' ' + c.text));
          const fig = c.figure ? figureEl(c.figure) : null;
          if (fig) kids.push(fig);
          return h('button', {
            class: 'choice' + (c.figure ? ' fig-choice' : '') + (ui.picked === c.key ? ' picked' : ''),
            id: 'choice-' + c.key, 'data-key': c.key,
            'aria-label': hideName ? ('选项 ' + c.key) : null,
            onclick: function () { ui.picked = c.key; ui.answer = c.key; renderQuestion(item); }
          }, kids);
        })));
      } else if (q.type === 'self') {
        card.append(h('textarea', {
          class: 'ans-input', id: 'ans', rows: 3, placeholder: '开放题：可以写下自己的思路（不会自动判分），再点「看参考答案并自评」', value: ui.answer,
          oninput: function (e) { ui.answer = e.target.value; }
        }));
      } else {
        card.append(h('input', {
          type: 'text', class: 'ans-input', id: 'ans', autocomplete: 'off', placeholder: '在这里输入答案（数字、分数、多个答案用逗号或“和”分开）', value: ui.answer,
          oninput: function (e) { ui.answer = e.target.value; },
          onkeydown: function (e) { if (e.key === 'Enter' && !e.isComposing) judgeAndGo(item); }
        }));
      }
      card.append(h('div', { class: 'row', style: 'margin-top:10px' },
        q.type === 'self' ? null : h('button', { class: 'primary', id: 'btn-submit', onclick: function () { judgeAndGo(item); } }, '提交答案'),
        q.type === 'choice' ? null : h('button', { id: 'btn-peek', onclick: function () { ui.phase = 'self'; ui.verdict = null; renderQuestion(item); } }, '看参考答案并自评'),
        h('button', { id: 'btn-skip', onclick: function () { ui.phase = 'skip'; renderQuestion(item); } }, '不会')));
    } else if (ui.phase === 'auto') {
      const ok = ui.verdict.verdict === 'correct';
      card.append(
        h('div', { class: 'muted' }, '你的答案：' + (q.type === 'choice' ? answerOfKey(q, ui.answer) : ui.answer)),
        h('div', { class: 'verdict ' + (ok ? 'ok' : 'no') }, ok ? '自动判定：正确' : '自动判定：不正确'),
        feedbackBlock(q),
        h('div', { class: 'row' },
          h('button', { class: 'primary', id: 'btn-next', onclick: function () { commit(ok ? 'correct' : 'wrong'); } }, '下一题'),
          h('button', { id: 'btn-flip', onclick: function () { commit(ok ? 'wrong' : 'correct'); } }, ok ? '判错了，我其实没做对' : '判错了，我其实做对了'),
          h('button', { onclick: function () { ui.phase = 'ask'; renderQuestion(item); } }, '重新作答')));
    } else if (ui.phase === 'skip') {
      card.append(
        h('div', { class: 'muted' }, '你选择了「不会」。看一下答案和解析再继续：'),
        feedbackBlock(q),
        h('div', { class: 'row' }, h('button', { class: 'primary', id: 'btn-next', onclick: function () { commit('skip'); } }, '下一题')));
    } else {
      card.append(
        ui.answer ? h('div', { class: 'muted' }, '你的答案：' + ui.answer) : null,
        q.type === 'self' ? h('div', { class: 'muted' }, '开放题：请对照参考答案自己判断。')
          : (ui.verdict ? h('div', { class: 'muted' }, '这道题的答案无法被自动可靠地判定，请对照参考答案自己判断。') : null),
        feedbackBlock(q),
        h('div', { class: 'row' },
          h('button', { class: 'good', id: 'btn-right', onclick: function () { commit('correct'); } }, '对（我做对了）'),
          h('button', { class: 'bad', id: 'btn-wrong', onclick: function () { commit('wrong'); } }, '不对'),
          h('button', { id: 'btn-skip2', onclick: function () { commit('skip'); } }, '不会')));
    }

    card.append(h('div', { class: 'notice' }, '提示：自动判题只是近似的（数字、分数、多个答案会做规范化后比较），一切以参考答案为准；判错了可以手动更正。'));
    card.append(h('div', { class: 'row no-print', style: 'margin-top:12px' },
      n > 0 ? h('button', { class: 'small', onclick: function () { rebuild(session.answers.slice(0, -1)); } }, '撤销上一题') : null,
      h('button', { class: 'small', onclick: function () { if (confirm('确定放弃当前诊断并回到开始页吗？')) restart(); } }, '重新开始')));
    const page = h('div');
    if (demo) page.append(demoBanner());
    const qBar = childBar('question');
    if (qBar) page.append(qBar);
    page.append(card);
    show(page);
    const inp = document.getElementById('ans');
    if (inp && inp.setSelectionRange && inp.tagName === 'INPUT') { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    else if (inp) inp.focus();
  }

  function answerOfKey(q, key) {
    const c = (q.choices || []).find(function (x) { return x.key === key; });
    return c ? c.key + '. ' + c.text : key;
  }

  function demoBanner() {
    return h('div', { class: 'banner demo no-print' }, '演示模式：由程序模拟一位学生作答（不会保存进度）。',
      h('a', { href: location.pathname }, '退出演示'));
  }

  /* ------------------------------------------------------------ 分享图 */
  function onShareKey(e) { if (e.key === 'Escape') closeShare(); }
  function closeShare() {
    shareToken++;
    document.removeEventListener('keydown', onShareKey);
    var modal = document.getElementById('share-modal');
    if (modal) modal.remove();
    document.body.classList.remove('share-open');
    if (shareBlobUrl) { URL.revokeObjectURL(shareBlobUrl); shareBlobUrl = null; }
  }
  function shareScopeText() {
    var raw = sessionMeta && sessionMeta.label ? String(sessionMeta.label) : '本次诊断';
    raw = raw.replace(/（整体筛查）/g, '').replace(/（整章）/g, '').replace(/（旧编号已对应到小学知识点）/g, '');
    raw = raw.replace(/\s+/g, ' ').trim();
    return raw || '本次诊断';
  }
  function buildShareModel(sum, chapters) {
    var subjectName = subject === 'english' ? '英语' : subject === 'physics' ? '物理' : subject === 'chinese' ? '语文' : '数学';
    var spots = [];
    var spotKind = 'topic';
    if (chapters && chapters.length) {
      spotKind = 'chapter';
      var hot = chapters.filter(function (c) { return c.weak > 0 || c.shaky > 0; });
      if (!hot.length) hot = chapters.slice(0, 3);
      spots = hot.slice(0, 3).map(function (c) {
        return { title: c.label, detail: '薄弱 ' + c.weak + ' · 不稳 ' + c.shaky + ' · 未测 ' + c.untested };
      });
    } else {
      var seen = Object.create(null);
      var ids = [];
      var pushId = function (id) {
        if (!id || seen[id] || ids.length >= 3) return;
        seen[id] = true;
        ids.push(id);
      };
      sum.roots.forEach(function (r) { pushId(r.id); });
      sum.weak.forEach(pushId);
      sum.shaky.forEach(pushId);
      spots = ids.map(function (id) {
        return { title: nameOf(id), detail: STATUS_LABEL[E.statusOf(session, id)] || '' };
      });
    }
    var now = new Date();
    return {
      siteName: '中小学·高中知识图谱',
      subject: subjectName,
      scope: shareScopeText(),
      mastered: sum.mastered.length,
      shaky: sum.shaky.length,
      weak: sum.weak.length,
      untested: sum.untested.length,
      spotKind: spotKind,
      spots: spots,
      roots: sum.roots.slice(0, 2).map(function (r) { return nameOf(r.id); }),
      date: now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日'
    };
  }
  function mountShareModal(url) {
    var old = document.getElementById('share-modal');
    if (old) old.remove();
    var img = h('img', { id: 'share-preview', alt: '诊断分享图', src: url });
    var modal = h('div', {
      id: 'share-modal', class: 'share-modal no-print', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'share-title',
      onclick: function (e) { if (e.target === modal) closeShare(); }
    }, h('div', { class: 'share-panel', onclick: function (e) { e.stopPropagation(); } },
      h('div', { class: 'share-bar' },
        h('h2', { id: 'share-title', text: '分享图' }),
        h('button', { type: 'button', id: 'share-close', onclick: closeShare }, '关闭')),
      h('p', { id: 'share-hint', class: 'share-hint', text: '长按图片保存' }),
      h('div', { class: 'share-scroll' }, img),
      h('div', { class: 'share-actions' },
        h('a', { id: 'share-download', class: 'btn btn-primary', href: url, download: '知识图谱诊断分享.png' }, '下载图片'))));
    document.body.classList.add('share-open');
    document.body.append(modal);
    document.addEventListener('keydown', onShareKey);
  }
  function openShare() {
    if (!window.ShareCard) {
      var host0 = document.getElementById('summary');
      if (host0) host0.append(h('p', { id: 'share-error', class: 'err', text: '分享图没有生成：组件没有加载' }));
      return;
    }
    var token = ++shareToken;
    var sum = E.summarize(D.graph, session);
    var chapters = session.mode === 'screen' ? E.chapterSummary(D.graph, session) : null;
    var model = buildShareModel(sum, chapters);
    window.__shareModel = model;
    var canvas = document.createElement('canvas');
    try { window.ShareCard.draw(canvas, model); }
    catch (err) {
      var host = document.getElementById('summary');
      if (host) host.append(h('p', { id: 'share-error', class: 'err', text: '分享图没有生成：' + (err && err.message ? err.message : err) }));
      return;
    }
    var finish = function (url) {
      if (token !== shareToken) {
        if (String(url).indexOf('blob:') === 0) URL.revokeObjectURL(url);
        return;
      }
      if (shareBlobUrl && shareBlobUrl !== url) URL.revokeObjectURL(shareBlobUrl);
      shareBlobUrl = String(url).indexOf('blob:') === 0 ? url : null;
      mountShareModal(url);
    };
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (token !== shareToken) return;
        if (!blob) { finish(canvas.toDataURL('image/png')); return; }
        finish(URL.createObjectURL(blob));
      }, 'image/png');
    } else finish(canvas.toDataURL('image/png'));
  }

  /* ------------------------------------------------------------ 结果页 */
  function standardsBlock(id) {
    const t = D.graph.byId[id];
    const list = t.standards || [];
    if (!list.length) return h('div', { class: 'muted small', text: t.external ? '小学阶段知识点，未对应第四学段课标条目。' : '没有对应的课标条目。' });
    return h('div', null, h('b', null, '课标条目：'), list.map(function (sd) {
      const item = D.stdById[sd.id];
      return h('div', { class: 'std' },
        h('code', { text: sd.id }), h('span', { class: 'conf', text: sd.confidence === 'exact' ? '直接对应' : '推断对应' }),
        h('div', { text: item ? item.text : '（课标文件中找不到该条目）' }),
        sd.note ? h('div', { class: 'muted small', text: '说明：' + sd.note }) : null);
    }));
  }

  function topicBody(id, extra) {
    const t = D.graph.byId[id];
    const body = h('div', { class: 'body' });
    body.append(h('div', { class: 'muted' }, (t.external ? '小学先修知识点（无诊断题）' : t.chapter) + (t.domain ? ' · ' + t.domain : '')));
    body.append(h('div', { text: t.description }));
    if (t.mastery_criteria && t.mastery_criteria.length) {
      body.append(h('div', null, h('b', null, '掌握标准：'), h('ul', null, t.mastery_criteria.map(function (m) { return h('li', { text: m }); }))));
    }
    if (extra) body.append(extra);
    body.append(standardsBlock(id));
    return body;
  }

  function topicItem(id, tags, extra) {
    const t = D.graph.byId[id];
    return h('details', { class: 'topic' },
      h('summary', null, tags, h('span', { text: t.name }), ' ', h('span', { class: 'muted small', text: t.external ? '小学' : t.chapter })),
      topicBody(id, extra));
  }

  function tag(cls, text) { return h('span', { class: 'tag ' + cls, text: text }); }
  function statusTags(id, rootSet, targetSet) {
    const st = E.statusOf(session, id);
    const out = [];
    if (targetSet.has(id)) out.push(tag('target', '目标'));
    if (rootSet.has(id)) out.push(tag('root', '根因'));
    out.push(tag(st, STATUS_LABEL[st]));
    if (D.graph.byId[id].external) out.push(tag('ext', '小学'));
    return out;
  }

  function renderResult() {
    const sum = E.summarize(D.graph, session);
    const rootSet = new Set(sum.roots.map(function (r) { return r.id; }));
    const screen = session.mode === 'screen';
    const targetSet = new Set(screen ? [] : session.targets);
    const page = h('div');
    if (demo) page.append(demoBanner());
    saveToChild(sum, finished);
    const resultBar = childBar('result');
    if (resultBar) page.append(resultBar);

    const targetsMastered = session.targets.every(function (id) { return E.statusOf(session, id) === 'mastered'; });
    const chapters = screen ? E.chapterSummary(D.graph, session) : null;
    const outOfScope = screen ? sum.roots.filter(function (r) { return r.outOfScopePrereqs.length; }) : [];
    let headline;
    // 筛查模式下 sum.weak / sum.shaky 会混进「顺着先修回查到的低年级基础点」，
    // 主 KPI 只报本年级的账，基础的问题留给下面的「连带回查」卡单独说，否则数字对不上。
    const fWeak = new Set((sum.foundation && sum.foundation.weak) || []);
    const fShaky = new Set((sum.foundation && sum.foundation.shaky) || []);
    const gradeWeak = sum.weak.filter(function (id) { return !fWeak.has(id); }).length;
    const gradeShaky = sum.shaky.filter(function (id) { return !fShaky.has(id); }).length;

    if (screen) {
      const f = sum.foundation || { checked: [], weak: [] };
      if (!sum.weak.length && !sum.shaky.length) headline = sum.untested.length
        ? '已测到的知识点没有发现薄弱点，另有 ' + sum.untested.length + ' 个没测到。'
        : '范围内的知识点都已掌握，没有发现薄弱点。';
      else headline = '本年级 ' + session.targets.length + ' 个知识点中：薄弱 ' + gradeWeak + '、不稳 ' + gradeShaky + '、未测 ' + sum.untested.length + '。' +
        (f.checked.length
          ? '顺着先修又回查了 ' + f.checked.length + ' 个过往基础点，其中 ' + f.weak.length + ' 个薄弱' +
            (f.weak.length >= f.checked.length / 2 ? '——问题多半压在基础层，建议先从下面的「连带回查」补起。' : '。')
          : '') +
        (f.checked.length ? '本年级的按章情况见下方「按章汇总」，本年级的章排在最前。' : '先看下面的「按章汇总」，薄弱的章排在前面。');
    }
    else if (!sum.roots.length && !sum.shaky.length && targetsMastered) headline = '目标知识点已掌握，没有发现需要补的先修。';
    else if (!sum.roots.length && !sum.shaky.length) headline = '没有判出薄弱点，但目标尚未全部测到。';
    else if (!sum.roots.length) headline = '没有判出薄弱点，但有 ' + sum.shaky.length + ' 个知识点「不稳」（第一题没答对、第二题答对），建议巩固。';
    else headline = '共发现 ' + sum.roots.length + ' 个薄弱根因' + (sum.shaky.length ? '、' + sum.shaky.length + ' 个不稳的知识点' : '') + '，按下面的学习路径从前往后补。';

    const summaryCard = h('div', { class: 'card', id: 'summary' },
      h('h2', { text: '诊断结果：' + sessionMeta.label }),
      h('p', null, headline),
      h('div', { class: 'stats' },
        stat('ask', sum.asked, '已答题数'),
        stat('bad', gradeWeak, screen ? '本年级薄弱' : '薄弱'),
        stat('shaky', gradeShaky, screen ? '本年级不稳' : '不稳'),
        stat('ok', sum.mastered.length, '已掌握'),
        stat('unk', sum.untested.length, '未测')),
      sum.unconfirmed.length ? h('p', { class: 'muted small' }, '「' + sum.unconfirmed.map(nameOf).join('」「') + '」只答了第一题（答错）就停下了，没来得及复测，暂按薄弱处理。') : null,
      screen && !sum.foundation.checked.length && sum.baseTotal
        ? h('p', { class: 'muted small' }, '本年级的题没有触发先修回查：' + sum.baseTotal + ' 个过往基础点按「上层会做 = 基础具备」推断为掌握，所以没有额外出题。')
        : null,
      finished && sum.untested.length
        ? h('p', { class: 'notice no-print' }, '这次先停在这里，已答 ' + sum.asked + ' 题，还有 ' + sum.untested.length + ' 个知识点没问到。薄弱根因的先修里若有没测的点，真正的根因可能更靠前。',
          h('button', { style: 'margin-left:8px', onclick: function () { finished = false; save(); render(); } }, '继续诊断'))
        : null,
      h('p', { class: 'muted small' }, '自动判题只是近似的，答题记录里可以更正任何一题。生成时间：' + new Date().toLocaleString('zh-CN')),
      h('div', { class: 'row no-print' },
        h('button', { class: 'primary', id: 'btn-share', onclick: openShare }, '生成分享图'),
        h('button', { id: 'btn-export', onclick: exportJson }, '导出 JSON'),
        h('button', { id: 'btn-print', onclick: printPage }, '打印 / 另存为 PDF'),
        h('button', { onclick: function () { if (confirm('重新开始会清除当前进度，确定吗？')) restart(); } }, '重新开始'),
        session.answers.length ? h('button', { onclick: function () { rebuild(session.answers.slice(0, -1)); } }, '撤销上一题') : null));
    page.append(summaryCard);
    if (screen) page.append(chaptersCard(chapters, outOfScope));
    if (sum.foundation && sum.foundation.checked.length) page.append(foundationCard(sum, rootSet, targetSet));

    page.append(h('div', { class: 'card', id: 'roots' },
      h('h2', { text: '薄弱的先修知识点（根因）' }),
      h('p', { class: 'muted small' }, '根因 = 被判为薄弱、且它的直接先修里没有薄弱点的知识点。点击展开看描述、掌握标准和课标条目。'),
      sum.roots.length ? sum.roots.map(function (r) {
        const notes = h('div');
        if (r.pendingPrereqs.length) notes.append(h('div', { class: 'notice', text: '它的先修「' + r.pendingPrereqs.map(nameOf).join('」「') + '」这次没测到，真正的根因可能更靠前。' }));
        if (r.outOfScopePrereqs.length) notes.append(h('div', { class: 'notice', text: '它的先修「' + r.outOfScopePrereqs.map(nameOf).join('」「') + '」不在所选范围内，没有检查。' }));
        if (r.externalPrereqs.length) notes.append(h('div', { class: 'muted small', text: '小学先修（无诊断题，未测）：' + r.externalPrereqs.map(nameOf).join('、') }));
        return topicItem(r.id, statusTags(r.id, rootSet, targetSet), notes);
      }) : h('p', { text: targetsMastered ? '没有。' : '暂未发现。' })));

    page.append(h('div', { class: 'card', id: 'shaky' },
      h('h2', { text: '不稳的知识点（' + sum.shaky.length + '）' }),
      h('p', { class: 'muted small' }, '第一题没答对，但第二题（同级或更容易）答对了：可能是粗心，也可能掌握得不牢。它们会出现在学习路径里需要巩固，但工具没有继续向它们的先修回溯（只有两题都错才回溯）。'),
      sum.shaky.length ? sum.shaky.map(function (id) { return topicItem(id, statusTags(id, rootSet, targetSet)); }) : h('p', { text: '没有。' })));

    page.append(h('div', { class: 'card', id: 'path' },
      h('h2', { text: '推荐学习路径' }),
      h('p', { class: 'muted small' }, '从根因（和「不稳」的点）出发到目标之间、尚未判定为掌握的知识点，按年级从低到高排列（同一年级里先修在前），从上往下学。「不稳」「未测」的点也在路径上，建议先巩固 / 自查。'),
      sum.path.length ? h('ol', { class: 'path' }, sum.path.map(function (p) {
        return h('li', null, topicItem(p.id, statusTags(p.id, rootSet, targetSet)));
      })) : h('p', { text: '不需要补课。' })));

    page.append(h('div', { class: 'card', id: 'graph' },
      h('h2', { text: '路径图' }),
      h('p', { class: 'muted small' }, '小学、初中和高中用不同颜色。硬先修是实线，软先修是虚线，点线表示中间省略了没画出来的知识点。红框是薄弱根因，橙框是目标。节点较多时先按年级收起中间点，可再展开。名称太长会省略，悬停或点按可看全名。滚轮缩放，拖动平移。上面的列表是完整学习顺序。'),
      h('div', { class: 'path-tools no-print' },
        h('button', { type: 'button', id: 'path-zoom-out', onclick: function () { pathZoom(0.8); } }, '缩小'),
        h('button', { type: 'button', id: 'path-zoom-in', onclick: function () { pathZoom(1.25); } }, '放大'),
        h('button', { type: 'button', id: 'path-fit', onclick: pathFit }, '适配画面')),
      h('p', { id: 'path-fold', class: 'graph-fold no-print', hidden: true }),
      h('ul', { class: 'legend' },
        h('li', null, h('i', { class: 'swatch sw-p' }), '小学'),
        h('li', null, h('i', { class: 'swatch sw-j' }), '初中'),
        h('li', null, h('i', { class: 'swatch sw-h' }), '高中'),
        h('li', null, h('i', { class: 'swatch sw-root' }), '薄弱根因'),
        h('li', null, h('i', { class: 'swatch sw-target' }), '目标'),
        h('li', null, h('i', { class: 'swatch line-hard' }), '硬先修（实线）'),
        h('li', null, h('i', { class: 'swatch line-soft' }), '软先修（虚线）'),
        h('li', null, h('i', { class: 'swatch line-skip' }), '中间省略（点线）')),
      h('div', { class: 'path-graph' },
        h('div', { id: 'path-cy', role: 'img', 'aria-label': '先修路径图' }),
        h('div', { id: 'node-tip', class: 'node-tip', role: 'tooltip', hidden: true }))));

    page.append(h('details', { class: 'card', id: 'mastered' },
      h('summary', null, h('b', null, '已掌握的知识点（' + sum.mastered.length + '）')),
      sum.mastered.map(function (id) {
        const src = session.status[id].src === 'direct' ? '答对' : '由后续知识点答对推断';
        return topicItem(id, [tag('mastered', src)].concat(D.graph.byId[id].external ? [tag('ext', '小学')] : []));
      })));

    page.append(h('details', { class: 'card', id: 'untested' },
      h('summary', null, h('b', null, '未测的知识点（' + sum.untested.length + '）')),
      h('p', { class: 'muted small' }, '题量用完，或不必再测，所以没问到的知识点。小学知识点同样会出题。'),
      sum.untested.map(function (id) { return topicItem(id, statusTags(id, rootSet, targetSet)); })));

    page.append(standardsCard(sum));
    page.append(logCard());
    show(page);
    mountPathGraph(sum);
  }

  function nameList(ids) { return ids.map(nameOf).join('、'); }

  /**
   * 连带回查的过往基础：筛查时顺着先修链下探到、并且真的出了题的低年级知识点。
   * 只列真正问过的，没被用到的低年级内容不会出现在这里，也不占题量。
   */
  function foundationCard(sum, rootSet, targetSet) {
    const f = sum.foundation;
    const rank = { weak: 0, shaky: 1, mastered: 2 };
    const list = f.checked.slice().sort(function (a, b) {
      const ra = rank[E.statusOf(session, a)] == null ? 3 : rank[E.statusOf(session, a)];
      const rb = rank[E.statusOf(session, b)] == null ? 3 : rank[E.statusOf(session, b)];
      return ra - rb;
    });
    return h('div', { class: 'card', id: 'foundation' },
      h('h2', { text: '连带回查的过往基础（' + f.checked.length + '）' }),
      h('p', { class: 'muted small' }, '所选范围下面的先修基础：本年级的题答错或不稳时，会顺着先修链往回追，追到的低年级知识点才会出题。没被用到的低年级内容不会重复考。基础没打牢，上面的知识点迟早还会卡住，建议先补这里。'),
      h('div', { class: 'stats', style: 'grid-template-columns:repeat(3,minmax(0,1fr))' },
        stat('bad', f.weak.length, '薄弱'),
        stat('shaky', f.shaky.length, '不稳'),
        stat('ok', f.mastered.length, '已掌握')),
      list.map(function (id) { return topicItem(id, statusTags(id, rootSet, targetSet)); }));
  }

  function chaptersCard(chapters, outOfScope) {
    const seg = function (cls, n, total) { return n ? h('i', { class: cls, style: 'width:' + (n / total * 100) + '%' }) : null; };
    return h('div', { class: 'card', id: 'chapters' },
      h('h2', { text: '按章汇总' }),
      h('p', { class: 'muted small' }, '每章的知识点掌握情况，本年级的章排在前面、薄弱多的优先；点开看具体是哪几个知识点。色条从左到右：掌握、不稳、薄弱、未测。带「基础」标记的章是顺着先修回查到的低年级内容。'),
      outOfScope.length ? h('p', { class: 'notice', id: 'out-of-scope' }, '部分薄弱点的先修在所选范围之外，未检查（涉及 ' + outOfScope.length + ' 个薄弱点，如「' +
        outOfScope.slice(0, 3).map(function (r) { return nameOf(r.id); }).join('」「') + '」）。可对这些知识点单独做诊断，沿先修继续往前查。') : null,
      chapters.map(function (c) {
        return h('details', { class: 'topic chap-sum', open: c.weak > 0 || c.shaky > 0 },
          h('summary', null,
            h('span', { class: 'chap-name', text: c.label }),
            c.fromBase ? h('span', { class: 'chap-base', text: '基础' }) : null,
            h('span', { class: 'chap-counts' },
              tag('mastered', '掌握 ' + c.mastered), tag('shaky', '不稳 ' + c.shaky), tag('weak', '薄弱 ' + c.weak), tag('unknown', '未测 ' + c.untested)),
            h('span', { class: 'chap-bar', 'aria-hidden': 'true' },
              seg('m', c.mastered, c.total), seg('s', c.shaky, c.total), seg('w', c.weak, c.total), seg('u', c.untested, c.total))),
          h('div', { class: 'body' },
            h('div', { class: 'muted small', text: '共 ' + c.total + ' 个知识点' }),
            c.weakIds.length ? h('div', { class: 'chap-names' }, tag('weak', '薄弱'), nameList(c.weakIds)) : null,
            c.shakyIds.length ? h('div', { class: 'chap-names' }, tag('shaky', '不稳'), nameList(c.shakyIds)) : null,
            !c.weakIds.length && !c.shakyIds.length ? h('div', { class: 'muted small', text: c.untested ? '没有发现薄弱或不稳的点，另有 ' + c.untested + ' 个没测到。' : '没有发现薄弱或不稳的点。' }) : null));
      }));
  }

  function stat(cls, n, label) {
    return h('div', { class: 'pt-kpi stat ' + cls },
      h('div', { class: 'pt-kpi-label' }, h('i', { class: 'pt-dot' }), label),
      h('div', { class: 'pt-kpi-value' }, String(n)));
  }

  function standardsCard(sum) {
    const ids = new Set(session.mode === 'screen' ? [] : session.targets);
    sum.path.forEach(function (p) { ids.add(p.id); });
    const by = {};
    ids.forEach(function (id) {
      (D.graph.byId[id].standards || []).forEach(function (sd) { (by[sd.id] || (by[sd.id] = [])).push(id); });
    });
    const keys = Object.keys(by).sort();
    return h('div', { class: 'card', id: 'standards' },
      h('h2', { text: '相关课标条目' }),
      h('p', { class: 'muted small' }, subject === 'physics'
        ? '目标与学习路径上的知识点对应的《义务教育物理课程标准（2022年版2025年修订）》和《普通高中物理课程标准（2017年版2020年修订）》内容要求（编号与课标条款一致）。'
        : subject === 'english'
        ? '目标与学习路径上的知识点对应的《义务教育英语课程标准（2022年版）》和《普通高中英语课程标准（2017年版2025年修订）》公开转述（一级、二级、三级，以及高中必修、选择性必修）。'
        : subject === 'chinese'
        ? '目标与学习路径上的知识点对应的《义务教育语文课程标准（2022年版）》第一至第三学段的公开转述。'
        : '目标与学习路径上的知识点对应的《义务教育数学课程标准（2022年版）》内容要求（第一至第四学段）。'),
      keys.length ? keys.map(function (k) {
        const item = D.stdById[k];
        return h('div', { class: 'std' }, h('code', { text: k }),
          h('div', { text: item ? item.text : '' }),
          h('div', { class: 'muted small', text: '对应知识点：' + by[k].map(nameOf).join('、') }));
      }) : h('p', { class: 'muted', text: '无。' }));
  }

  function logCard() {
    const rows = session.answers.map(function (a, i) {
      const q = E.questionById(D.graph, a.qid) || { prompt: '', answer: '' };
      const sel = h('select', {
        onchange: function (e) {
          const next = session.answers.map(function (x, j) { return j === i ? Object.assign({}, x, { result: e.target.value }) : x; });
          rebuild(next);
        }
      }, ['correct', 'wrong', 'skip'].map(function (r) { return h('option', { value: r, selected: r === a.result }, RESULT_LABEL[r]); }));
      return h('tr', null, h('td', { text: String(i + 1) }),
        h('td', null, nameOf(a.id), h('div', { class: 'muted small', text: q.prompt.length > 60 ? q.prompt.slice(0, 59) + '…' : q.prompt })),
        h('td', { class: 'muted', text: a.text || '' }),
        h('td', null, sel), h('td', { class: 'muted', text: q.answer }));
    });
    return h('div', { class: 'card', id: 'log' },
      h('h2', { text: '答题记录（可更正）' }),
      h('p', { class: 'muted small' }, '自动判题可能判错。在这里改某一题的结果会重新计算整份诊断（后续是否还需要追问也会随之变化）。'),
      session.answers.length ? h('table', { class: 'log' },
        h('thead', null, h('tr', null, h('th', { text: '#' }), h('th', { text: '知识点 / 题目' }), h('th', { text: '你的答案' }), h('th', { text: '结果' }), h('th', { text: '参考答案' }))),
        h('tbody', null, rows)) : h('p', { class: 'muted', text: '还没有答题。' }));
  }

  /* ------------------------------------------------------------ 路径图（Cytoscape + dagre） */
  function stageKind(grade) { return grade <= 6 ? 'primary' : grade <= 9 ? 'junior' : 'senior'; }
  function gradeWord(grade) {
    const cn = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (subject === 'english') {
      if (grade >= 1 && grade <= 9) return cn[grade] + '年级';
      const en = { 10: '必修一', 11: '必修二', 12: '必修三', 13: '选必一', 14: '选必二', 15: '选必三', 16: '选必四' };
      return en[grade] || ('册' + grade);
    }
    if (grade >= 1 && grade <= 9) return cn[grade] + '年级';
    if (subject === 'physics') return { 10: '必修一', 11: '必修二', 12: '必修三', 13: '选必一', 14: '选必二', 15: '选必三' }[grade] || ('册' + grade);
    const math = { 10: '高一', 11: '高二', 12: '选必一', 13: '选必二', 14: '选必三' };
    return math[grade] || ('年级' + grade);
  }
  function toneOf(kind, colors) {
    if (kind === 'primary') return [colors.primaryBg, colors.primary];
    if (kind === 'junior') return [colors.juniorBg, colors.junior];
    return [colors.seniorBg, colors.senior];
  }
  function pathNodeElement(n, colors) {
    const topic = D.graph.byId[n.id];
    const grade = topic && typeof topic.grade === 'number' ? topic.grade : 7;
    const kind = stageKind(grade);
    const name = nameOf(n.id);
    const bits = [name];
    if (n.isRoot) bits.push('薄弱根因');
    if (n.isTarget) bits.push('目标');
    bits.push(STATUS_LABEL[n.status] || n.status);
    const tone = toneOf(kind, colors);
    let bg = tone[0];
    let border = tone[1];
    if (n.isTarget) { bg = colors.currentBg; border = colors.currentBorder; }
    if (n.isRoot) { bg = colors.badBg; border = colors.bad; }
    const classes = [kind];
    if (n.isRoot) classes.push('root');
    if (n.isTarget) classes.push('target', 'current');
    return {
      data: { id: n.id, name: name, full: bits.join(' · '), label: clipLabel(name), bg: bg, border: border, color: colors.text },
      classes: classes.join(' ')
    };
  }
  function buildPathElements(lay, colors, folded) {
    const elements = [];
    const bucket = new Map();
    const gradeMembers = new Map();
    lay.nodes.forEach(function (n) {
      if (!folded || n.isRoot || n.isTarget) {
        bucket.set(n.id, n.id);
        elements.push(pathNodeElement(n, colors));
        return;
      }
      const topic = D.graph.byId[n.id];
      const grade = topic && typeof topic.grade === 'number' ? topic.grade : 0;
      if (!gradeMembers.has(grade)) gradeMembers.set(grade, []);
      gradeMembers.get(grade).push(n.id);
    });
    gradeMembers.forEach(function (ids, grade) {
      const id = 'grade-' + grade;
      const kind = stageKind(grade);
      const tone = toneOf(kind, colors);
      const name = gradeWord(grade) + '·' + ids.length + '个';
      elements.push({
        data: {
          id: id, name: name, full: gradeWord(grade) + '的 ' + ids.length + ' 个知识点',
          label: clipLabel(name), bg: tone[0], border: tone[1], color: colors.text
        },
        classes: kind + ' grade'
      });
      ids.forEach(function (topicId) { bucket.set(topicId, id); });
    });
    const seen = new Map();
    lay.edges.forEach(function (e) {
      const a = bucket.get(e.from);
      const b = bucket.get(e.to);
      if (!a || !b || a === b) return;
      const key = a + '>' + b;
      const kind = !e.direct ? 'indirect' : (e.strength === 'soft' ? 'soft' : 'hard');
      const rank = kind === 'hard' ? 3 : kind === 'soft' ? 2 : 1;
      const prev = seen.get(key);
      if (!prev || rank > prev.rank) seen.set(key, { kind: kind, rank: rank });
    });
    let edgeIndex = 0;
    seen.forEach(function (info, key) {
      const parts = key.split('>');
      const color = info.kind === 'hard' ? colors.edge : colors.edgeSoft;
      elements.push({
        data: { id: 'e' + (edgeIndex++), source: parts[0], target: parts[1], color: color },
        classes: info.kind
      });
    });
    return elements;
  }
  function updatePathFold(total, folded) {
    const box = document.getElementById('path-fold');
    if (!box) return;
    if (total <= PATH_FOLD_AT) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    if (folded) {
      box.replaceChildren(
        document.createTextNode('路径较长，已按年级收起中间知识点。根因和目标仍单独画出。'),
        h('button', { type: 'button', id: 'btn-path-expand', text: '展开全部 ' + total + ' 个' })
      );
    } else {
      box.replaceChildren(
        document.createTextNode('已展开全部 ' + total + ' 个知识点。'),
        h('button', { type: 'button', id: 'btn-path-collapse', text: '按年级收起' })
      );
    }
  }
  function pathZoom(factor) {
    if (!pathCy) return;
    const rect = pathCy.container().getBoundingClientRect();
    pathCy.zoom({
      level: Math.max(pathCy.minZoom(), Math.min(pathCy.maxZoom(), pathCy.zoom() * factor)),
      renderedPosition: { x: rect.width / 2, y: rect.height / 2 }
    });
  }
  function pathFit() {
    if (!pathCy) return;
    pathCy.resize();
    const many = pathCy.nodes().length > 48;
    if (many) pathCy.minZoom(0.45);
    pathCy.fit(undefined, 28);
    if (many && pathCy.zoom() < 0.45) {
      pathCy.zoom(0.55);
      pathCy.center();
    }
  }
  function hidePathTip() {
    const tip = document.getElementById('node-tip');
    if (tip) tip.hidden = true;
  }
  function showPathTip(node) {
    const tip = document.getElementById('node-tip');
    const stage = document.querySelector('.path-graph');
    if (!tip || !stage || !pathCy || !node || node.empty()) return;
    const text = node.data('full') || node.data('label') || '';
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.hidden = false;
    const stageRect = stage.getBoundingClientRect();
    const cyRect = pathCy.container().getBoundingClientRect();
    const bb = node.renderedBoundingBox({ includeLabels: true });
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const cx = cyRect.left - stageRect.left + (bb.x1 + bb.x2) / 2;
    const top = cyRect.top - stageRect.top + bb.y1;
    let left = Math.max(8, Math.min(cx - tipW / 2, Math.max(8, stageRect.width - tipW - 8)));
    let y = top - tipH - 8;
    if (y < 4) y = cyRect.top - stageRect.top + bb.y2 + 8;
    if (y + tipH > stageRect.height - 4) y = Math.max(4, stageRect.height - tipH - 4);
    tip.style.left = left + 'px';
    tip.style.top = y + 'px';
  }
  function ensureDagre() {
    if (!window.cytoscape || !window.dagre || !window.cytoscapeDagre) throw new Error('图形库没有加载');
    if (!ensureDagre.ready) { window.cytoscape.use(window.cytoscapeDagre); ensureDagre.ready = true; }
  }
  function mountPathGraph(sum) {
    const token = ++pathToken;
    if (pathCy) { pathCy.destroy(); pathCy = null; window.__pathCy = null; }
    const cyEl = document.getElementById('path-cy');
    if (!cyEl) return;
    cyEl.dataset.ready = '0';
    hidePathTip();
    const lay = E.layout(D.graph, session, sum);
    requestAnimationFrame(function () {
      if (token !== pathToken || !document.body.contains(cyEl)) return;
      try {
        ensureDagre();
        const colors = theme();
        const narrow = labelLimit() <= 8;
        const textMax = narrow ? 104 : 126;
        const boxW = narrow ? 118 : 142;
        const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif';
        const total = lay.nodes.length;
        const folded = total > PATH_FOLD_AT && !pathExpanded;
        const heavy = !folded && total > 48;
        updatePathFold(total, folded);
        cyEl.dataset.mode = folded ? 'grade' : 'full';
        cyEl.dataset.total = String(total);
        const elements = buildPathElements(lay, colors, folded);
        pathCy = window.cytoscape({
          container: cyEl,
          elements: elements,
          minZoom: heavy ? 0.45 : 0.2,
          maxZoom: 2.8,
          wheelSensitivity: 0.28,
          boxSelectionEnabled: false,
          autoungrabify: true,
          userPanningEnabled: true,
          userZoomingEnabled: true,
          style: [
            { selector: 'node', style: {
              label: 'data(label)', 'text-wrap': 'ellipsis', 'text-max-width': textMax + 'px',
              'text-overflow-wrap': 'anywhere',
              'text-valign': 'center', 'text-halign': 'center',
              'font-size': 13, 'font-family': FONT, color: 'data(color)',
              'background-color': 'data(bg)', 'border-width': 2, 'border-color': 'data(border)',
              shape: 'round-rectangle', width: boxW, height: 34, padding: 0, 'corner-radius': 8
            } },
            { selector: 'node.current', style: { 'border-width': 4, 'z-index': 8 } },
            { selector: 'node.root', style: {
              'background-color': colors.badBg, 'border-color': colors.bad, 'border-width': 4, 'z-index': 11
            } },
            { selector: 'edge', style: {
              width: 1.6, 'line-color': 'data(color)', 'target-arrow-color': 'data(color)',
              'target-arrow-shape': 'triangle', 'curve-style': heavy ? 'straight' : 'bezier', 'arrow-scale': 0.8, 'line-style': 'solid'
            } },
            { selector: 'edge.soft', style: { 'line-style': 'dashed', width: 1.5 } },
            { selector: 'edge.indirect', style: { 'line-style': 'dotted', width: 1.4 } }
          ]
        });
        window.__pathCy = pathCy;
        pathCy.on('mouseover', 'node', function (event) { showPathTip(event.target); });
        pathCy.on('mouseout', 'node', function () { if (!pathTipLock) hidePathTip(); });
        pathCy.on('tap', 'node', function (event) { pathTipLock = true; showPathTip(event.target); });
        pathCy.on('tap', function (event) {
          if (event.target === pathCy) { pathTipLock = false; hidePathTip(); }
        });
        const layout = pathCy.layout({
          name: 'dagre', rankDir: 'TB',
          rankSep: heavy ? 46 : 64,
          nodeSep: heavy ? 16 : 22,
          edgeSep: heavy ? 8 : 10,
          ranker: heavy ? 'longest-path' : 'network-simplex',
          padding: 16, animate: false, fit: true, nodeDimensionsIncludeLabels: false, spacingFactor: heavy ? 1.02 : 1.05
        });
        layout.one('layoutstop', function () {
          if (token !== pathToken || !pathCy) return;
          requestAnimationFrame(function () {
            if (token !== pathToken || !pathCy) return;
            pathCy.resize();
            pathCy.fit(undefined, heavy ? 20 : 24);
            if (heavy && pathCy.zoom() < 0.7) {
              pathCy.zoom(0.8);
              const focusNode = lay.nodes.find(function (n) { return n.isRoot; }) || lay.nodes.find(function (n) { return n.isTarget; }) || lay.nodes[0];
              const focus = focusNode ? pathCy.getElementById(focusNode.id) : null;
              if (focus && !focus.empty()) pathCy.center(focus);
            }
            cyEl.dataset.ready = '1';
          });
        });
        layout.run();
      } catch (error) {
        cyEl.dataset.ready = 'err';
        cyEl.append(h('p', { class: 'muted', text: '图没有画出来：' + (error && error.message ? error.message : error) }));
      }
    });
  }

  /* ------------------------------------------------------------ 导出 / 打印 */
  function exportJson() {
    const sum = E.summarize(D.graph, session);
    const stdIds = new Set();
    const brief = function (id) { return { id: id, name: nameOf(id) }; };
    sum.path.concat(session.mode === 'screen' ? [] : session.targets.map(function (id) { return { id: id }; })).forEach(function (p) {
      (D.graph.byId[p.id].standards || []).forEach(function (sd) { stdIds.add(sd.id); });
    });
    const chapters = session.mode === 'screen' ? E.chapterSummary(D.graph, session) : null;
    const out = {
      tool: 'cn-math-taxonomy/diagnose', version: 2, mode: session.mode || 'target', generatedAt: new Date().toISOString(),
      note: '自动判题是近似的，以参考答案为准。',
      label: sessionMeta.label,
      targets: session.targets.map(brief),
      limit: session.limit, seed: session.seed, asked: sum.asked, finished: sum.finished, limitReached: sum.limitReached,
      answers: session.answers.map(function (a, i) {
        const q = E.questionById(D.graph, a.qid) || {};
        return {
          order: i + 1, topicId: a.id, name: nameOf(a.id), questionId: a.qid, difficulty: q.difficulty, type: q.type,
          prompt: q.prompt, userAnswer: a.text == null ? null : a.text, result: a.result,
          referenceAnswer: q.answer, explanation: q.explanation || ''
        };
      }),
      chapters: chapters ? chapters.map(function (c) {
        return {
          label: c.label, total: c.total, mastered: c.mastered, shaky: c.shaky, weak: c.weak, untested: c.untested,
          weakTopics: c.weakIds.map(brief), shakyTopics: c.shakyIds.map(brief), untestedTopics: c.untestedIds.map(brief)
        };
      }) : undefined,
      weakRoots: sum.roots.map(function (r) {
        return Object.assign(brief(r.id), {
          pendingPrereqs: r.pendingPrereqs, outOfScopePrereqs: r.outOfScopePrereqs, externalPrereqs: r.externalPrereqs,
          masteryCriteria: D.graph.byId[r.id].mastery_criteria || [],
          standards: (D.graph.byId[r.id].standards || []).map(function (sd) { return sd.id; })
        });
      }),
      path: sum.path.map(function (p, i) { return Object.assign({ order: i + 1 }, brief(p.id), { status: p.status, isRoot: p.isRoot, isTarget: p.isTarget }); }),
      weak: sum.weak.map(brief),
      shaky: sum.shaky.map(brief),
      mastered: sum.mastered.map(function (id) { return Object.assign(brief(id), { source: session.status[id].src }); }),
      untested: sum.untested.map(function (id) { return Object.assign(brief(id), { external: !!D.graph.byId[id].external }); }),
      standards: Array.from(stdIds).sort().map(function (k) { return { id: k, text: D.stdById[k] ? D.stdById[k].text : '' }; })
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'diagnosis-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function printPage() { window.print(); }
  window.addEventListener('beforeprint', function () {
    document.querySelectorAll('details:not([open])').forEach(function (d) { d.setAttribute('open', ''); d.dataset.autoOpen = '1'; });
    if (pathCy) { pathCy.resize(); pathCy.fit(undefined, 20); }
  });
  window.addEventListener('afterprint', function () {
    document.querySelectorAll('details[data-auto-open]').forEach(function (d) { d.removeAttribute('open'); delete d.dataset.autoOpen; });
  });

  /* ------------------------------------------------------------ 启动 */
  function resolveTargets(params) {
    const t = params.get('target');
    if (t) {
      const raw = t.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      const ids = E.resolveTargets(raw, D.aliases);
      const bad = ids.filter(function (id) { return !D.graph.byId[id] || D.graph.byId[id].external; });
      if (bad.length) throw new Error('URL 参数 target 里有无效知识点：' + bad.join(', '));
      const aliased = raw.filter(function (id) { return D.aliases[id]; });
      let label = ids.map(nameOf).join('、');
      if (aliased.length) {
        label = aliased.map(function (id) { return (D.aliases[id].name || id); }).join('、') + '（旧编号已对应到小学知识点）';
        if (ids.length <= 6) label += '：' + ids.map(nameOf).join('、');
      }
      return { ids: ids, label: label };
    }
    const c = params.get('chapter');
    if (c) {
      const hit = [];
      VOLUMES.forEach(function (vv) {
        ((D.tree[vv[0]] || {}).chapters || []).forEach(function (ch) { if (ch.key === c.trim()) hit.push(ch); });
      });
      if (!hit.length) throw new Error('URL 参数 chapter 没有匹配的章节：' + c + '（格式如 “七上 第一章”）');
      return { ids: hit[0].topics.map(function (x) { return x.t.id; }), label: hit[0].volume + ' ' + hit[0].label + '（整章）' };
    }
    const grade = (params.get('grade') || '').trim();
    const volume = (params.get('volume') || '').trim();
    if (grade || volume) {
      let scope = volume || grade;
      const seniorUrl = {
        '高一': '高一', '高一必修': '高一', '高二': '高二', '高二必修': '高二',
        '选必一': '选必一', '选择性必修第一册': '选必一',
        '选必二': '选必二', '选择性必修第二册': '选必二',
        '选必三': '选必三', '选择性必修第三册': '选必三',
        '选必四': '选必四', '选择性必修第四册': '选必四',
        '必修一': '必修一', '必修第一册': '必修一',
        '必修二': '必修二', '必修第二册': '必修二',
        '必修三': '必修三', '必修第三册': '必修三'
      };
      if (seniorUrl[grade]) {
        if (volume && volume !== '必修' && volume !== '整册' && volume !== '必修整册') {
          throw new Error(subject === 'english'
            ? '高中英语不拆上下册：' + grade + ' / ' + volume + '（用 grade=必修一 或 grade=选必一）'
            : subject === 'physics'
            ? '高中物理不拆上下册：' + grade + ' / ' + volume + '（用 grade=必修一 或 grade=选必一）'
            : '高中不拆上下册：' + grade + ' / ' + volume + '（用 grade=高一、grade=高二 或 grade=选必二）');
        }
        scope = seniorUrl[grade];
      } else if (grade && volume) {
        const gch = /^[一二三四五六七八九]$/.test(grade) ? grade : grade.charAt(0);
        scope = (volume === '全' || volume === '全一册') ? gch + '全' : (/^[上下]$/.test(volume) ? gch + volume : volume);
        if (scope.charAt(0) !== gch) throw new Error('URL 参数 grade 与 volume 不一致：' + grade + ' / ' + volume);
      }
      if (/^[一二三四五六七八九]$/.test(scope)) scope += '年级';
      const g = E.gradeTargets(D.graph, scope, subject, { cumulative: true });
      if (!g) throw new Error('URL 参数 grade / volume 无法识别：' + (volume || grade) + '（写法如 grade=七年级、volume=七上）');
      return { ids: g.ids, base: g.base, label: g.label + '（年级诊断）', mode: 'screen' };
    }
    return null;
  }

  async function init() {
    subject = detectSubject();
    applySubjectChrome();
    try { await loadData(); } catch (e) {
      clearRoot();
      root.append(h('div', { class: 'card' }, h('h2', { class: 'err', text: '数据加载失败' }),
        h('p', null, String(e.message || e)),
        h('p', null, '请在项目根目录运行 ', h('code', { text: 'python3 -m http.server 8000' }), '，再访问 http://localhost:8000/diagnose/ （不能直接用 file:// 打开）。')));
      return;
    }
    const params = new URLSearchParams(location.search);
    let resolved = null;
    try { resolved = resolveTargets(params); } catch (e) { renderStart(e.message); return; }
    if (params.get('seed')) seedParam = params.get('seed');
    if (resolved && params.get('demo')) {
      demo = { oracle: makeOracle(resolved.ids, resolved.mode) };
      session = E.createSession(D.graph, resolved.ids, {
        mode: resolved.mode, open: true, base: resolved.base, seed: seedParam == null ? 'demo' : seedParam
      });
      sessionMeta = { label: resolved.label };
      const step = parseInt(params.get('step'), 10);
      runDemo(step >= 0 ? step : Infinity);
      render();
      return;
    }
    if (resolved) {
      const saved = lsGet(sessionKey());
      const same = saved && JSON.stringify(saved.targets) === JSON.stringify(Array.from(new Set(resolved.ids))) &&
        (saved.mode || 'target') === (resolved.mode || 'target') && (seedParam == null || saved.seed === seedParam);
      if (same && restoreSession(saved)) { render(); return; }
      startSession(resolved.ids, resolved.label, resolved.mode, resolved.base);
      return;
    }
    // 年级模式：刷新后直接接着上次，不用先回开始页
    if (startMode === 'grade') {
      const saved = lsGet(sessionKey());
      if (saved && saved.mode === 'screen' && Array.isArray(saved.targets) && saved.targets.length && restoreSession(saved)) {
        render();
        return;
      }
    }
    renderStart();
  }

  document.addEventListener('click', function (event) {
    const origin = event.target && event.target.closest ? event.target : (event.target && event.target.parentElement);
    if (!origin || !origin.closest) return;
    if (!origin.closest('#btn-path-expand') && !origin.closest('#btn-path-collapse')) return;
    pathExpanded = !!origin.closest('#btn-path-expand');
    if (session && D) mountPathGraph(E.summarize(D.graph, session));
  });

  if (window.matchMedia) {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const relayout = function () {
      if (!session || !document.getElementById('path-cy')) return;
      mountPathGraph(E.summarize(D.graph, session));
    };
    if (scheme.addEventListener) scheme.addEventListener('change', relayout);
    const narrow = window.matchMedia('(max-width: 700px)');
    if (narrow.addEventListener) narrow.addEventListener('change', relayout);
  }

  init();
})();
