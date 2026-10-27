/* 复习与考察
   ----------------------------------------------------------------------------
   流程：选薄弱知识点 → 让模型出一套低/中/高三档的题 → 学生作答 → 客观题本地判、
         主观题回模型批 → 汇总报告，可存进孩子档案。

   设计取舍：
   - 客观题本地判分，快且不花额度；只有解答题交给模型批，并要求给分步评分点。
   - 模型输出当不可信文本处理：只做 JSON 解析，全部用 textContent 渲染，从不拼 HTML。
   - 一份卷子的每题都带 topicId，报告能指回知识图谱。
   ========================================================================== */
(function () {
  'use strict';

  var CC = window.CnmChildren;
  var SC = window.CnmScope;
  var LLM = window.RvLLM;
  var PR = window.RvPrompts;
  var WEB = window.RvWeb;

  var LS_PREFS = 'cnmReview.prefs.v1';
  var LS_SETS = 'cnmReview.sets.v1';
  var MAX_SETS = 12;
  var MAX_PICK = 3;
  var COOLDOWN_MS = 4000;

  var root = document.getElementById('root');
  var headEl = document.getElementById('rv-head');
  var sideEl = document.getElementById('rv-side');
  var stageEl = document.getElementById('rv-stage');

  var GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级', '高一', '高二', '高三'];

  var ST = {
    subject: 'math',
    data: null,
    child: null,
    grade: '',
    term: '',
    textbook: '',
    picked: [],
    book: '',
    pickOrigin: '',
    count: 1,
    model: '',
    models: [],
    modelsErr: '',
    busy: '',
    busyNote: '',
    chars: 0,
    err: '',
    set: null,
    answers: {},
    photos: {},
    photoNote: '',
    grade2: null,
    gradeErr: '',
    showPicker: false,
    swapNote: '',
    q: '',
    webOn: false,
    links: '',
    cfgOpen: false,
    chanOpen: false,
    chanNote: '',
    chanTone: '',
    lastGenAt: 0,
    advanced: false
  };

  var abortCtl = null;

  /* ---------------------------------------------------------------- 小工具 */

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // 只用于本文件写死的图标 SVG
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function pill(text, tone) { return h('span', { class: 'pt-pill is-' + (tone || 'gray'), text: text }); }

  function readLS(k, fb) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch (e) { return fb; }
  }
  function writeLS(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }
  function uid() { return 'rv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function fmtMin(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return ('0' + n).slice(-2); };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function round1(n) { return Math.round(n * 10) / 10; }

  function subjectOf(t) {
    if (!t) return 'math';
    if (t.subject === 'english' || t.subject === 'math' || t.subject === 'physics' || t.subject === 'chinese') return t.subject;
    var id = String(t.id || '');
    if (id.indexOf('cne_') === 0) return 'english';
    if (id.indexOf('cnp_') === 0) return 'physics';
    if (id.indexOf('cnc_') === 0) return 'chinese';
    return 'math';
  }

  var LEVEL_NAME = { low: '基础', mid: '变式', high: '综合' };
  var LEVEL_FULL = { low: '基础巩固', mid: '变式应用', high: '综合迁移' };
  var TYPE_NAME = { choice: '单项选择', blank: '填空', solution: '解答' };

  /* ---------------------------------------------------------------- 偏好 */

  function loadPrefs() {
    var p = readLS(LS_PREFS, {}) || {};
    ST.count = p.count === 2 ? 2 : 1;
    ST.model = p.model || '';
    if (p.subject === 'chinese' || p.subject === 'english' || p.subject === 'physics' || p.subject === 'math') {
      ST.subject = p.subject;
    }
    ST.webOn = !!p.webOn;
    ST.links = p.links || '';
    ST.advanced = !!p.advanced;
  }
  function savePrefs() {
    writeLS(LS_PREFS, {
      count: ST.count, model: ST.model, webOn: ST.webOn,
      links: ST.links, advanced: ST.advanced, subject: ST.subject
    });
  }

  function loadSets() {
    var arr = readLS(LS_SETS, []);
    return Array.isArray(arr) ? arr : [];
  }
  function persistSet() {
    if (!ST.set) return;
    var arr = loadSets();
    var i = arr.map(function (x) { return x.id; }).indexOf(ST.set.id);
    var row = {
      id: ST.set.id, at: ST.set.at, childId: ST.child ? ST.child.id : null,
      subject: ST.subject, title: ST.set.title, topicIds: ST.set.topicIds,
      model: ST.model, questions: ST.set.questions, answers: ST.answers,
      grade: ST.grade2, savedToChild: !!ST.set.savedToChild
    };
    if (i >= 0) arr[i] = row; else arr.unshift(row);
    writeLS(LS_SETS, arr.slice(0, MAX_SETS));
  }

  /* ---------------------------------------------------------------- 数据 */

  function loadData() {
    var urls = ['../data/topics.json', '../data/dependencies.json'];
    return Promise.all(urls.map(function (u) { return fetch(u); })).then(function (rs) {
      rs.forEach(function (r, i) { if (!r.ok) throw new Error(urls[i] + ' HTTP ' + r.status); });
      return Promise.all(rs.map(function (r) { return r.json(); }));
    }).then(function (js) {
      var byId = {};
      js[0].forEach(function (t) { byId[t.id] = t; });
      var prereq = {};
      js[1].forEach(function (d) {
        if (!d || !d.topicId || !d.prerequisiteId) return;
        (prereq[d.topicId] = prereq[d.topicId] || []).push(d.prerequisiteId);
      });
      ST.data = { topics: js[0], byId: byId, prereq: prereq };
    });
  }

  function topicsOfSubject() {
    if (!ST.data) return [];
    return ST.data.topics.filter(function (t) { return subjectOf(t) === ST.subject && !t.external; });
  }

  /* ------------------------------------------------------------ 册（年级+学期） */

  var CN_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

  /* 章节名的第一段就是册：「五年级上册 第1单元 …」/「七上 第一章 …」/「选必一 第一章 …」 */
  function bookOfTopic(t) {
    return String((t && t.chapter) || '').split(/\s+/)[0] || '';
  }

  /* 把册名压成 {类型, 序号, 学期, 排序键}，各学科的写法都得认 */
  function parseBook(label) {
    var s = String(label || '').trim();
    var m;
    if ((m = s.match(/^([一二三四五六七八九])\s*(?:年级)?\s*(上|下|全)/))) {
      var n = CN_NUM[m[1]];
      return { kind: 'p', n: n, term: m[2] === '全' ? '' : m[2], rank: n * 10 + (m[2] === '上' ? 0 : m[2] === '下' ? 1 : 2) };
    }
    if ((m = s.match(/^高([一二])/))) return { kind: 'h', n: CN_NUM[m[1]], term: '', rank: 200 + CN_NUM[m[1]] };
    if ((m = s.match(/^必修\s*(?:第)?([一二三四])/))) return { kind: 'r', n: CN_NUM[m[1]], term: '', rank: 300 + CN_NUM[m[1]] };
    if ((m = s.match(/^选(?:择性)?必(?:修)?\s*(?:第)?([一二三四])/))) return { kind: 'o', n: CN_NUM[m[1]], term: '', rank: 400 + CN_NUM[m[1]] };
    return { kind: 'x', n: 0, term: '', rank: 900 };
  }

  /* 共享范围里的年级键（'五' / '高一' / '选必一'）→ 与册名可比的形式 */
  function scopeKey(g, term) {
    var s = String(g || '');
    var m;
    if ((m = s.match(/^([一二三四五六七八九])(?:年级)?$/))) {
      return { kind: 'p', n: CN_NUM[m[1]], term: term === '下' ? '下' : (term === '上' ? '上' : '') };
    }
    if ((m = s.match(/^高([一二])$/))) return { kind: 'h', n: CN_NUM[m[1]], term: '' };
    if ((m = s.match(/^必修([一二三四])$/))) return { kind: 'r', n: CN_NUM[m[1]], term: '' };
    if ((m = s.match(/^选必([一二三四])$/))) return { kind: 'o', n: CN_NUM[m[1]], term: '' };
    return null;
  }

  function books() {
    if (!ST.data) return [];
    var map = {};
    topicsOfSubject().forEach(function (t) {
      var lab = bookOfTopic(t);
      if (!lab) return;
      if (!map[lab]) map[lab] = { label: lab, count: 0, meta: parseBook(lab) };
      map[lab].count++;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return (a.meta.rank - b.meta.rank) || a.label.localeCompare(b.label); });
  }

  /* 当前范围落在哪一册：对不上就返回空，交给第一册兜底 */
  function bookForScope() {
    var sc = currentScope();
    /* 没档案也没手动选过：跟页面其他地方的兜底年级保持一致，别落到一年级 */
    var want = sc && sc.grade ? scopeKey(sc.grade, sc.term) : scopeKey('四', '');
    if (!want) return '';
    var list = books();
    for (var i = 0; i < list.length; i++) {
      var m = list[i].meta;
      if (m.kind === want.kind && m.n === want.n && (want.term === '' || m.term === want.term)) return list[i].label;
    }
    return '';
  }

  function currentBook() {
    var list = books();
    if (ST.book && list.some(function (b) { return b.label === ST.book; })) return ST.book;
    var fb = bookForScope();
    if (fb) return fb;
    return list.length ? list[0].label : '';
  }

  function topicsInBook(label) {
    var list = topicsOfSubject();
    if (!label) return list;
    return list.filter(function (t) { return bookOfTopic(t) === label; });
  }

  /* 抽几个点：尽量来自不同章节，拼出来才像一套综合题 */
  function sampleSpread(pool, n) {
    var arr = pool.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    var out = [];
    var seen = {};
    arr.forEach(function (t) {
      if (out.length >= n) return;
      if (seen[t.chapter]) return;
      seen[t.chapter] = true;
      out.push(t);
    });
    arr.forEach(function (t) {
      if (out.length >= n) return;
      if (out.indexOf(t) >= 0) return;
      out.push(t);
    });
    return out.slice(0, n);
  }

  function childGrade() {
    var sc = currentScope();
    if (sc && sc.grade) return SC.text(sc);
    return ST.grade || '四年级';
  }
  function childTextbook() {
    return (ST.child && ST.child.textbook) || ST.textbook || '人教版';
  }

  /* 全站共享的学习范围：手动指定 > 当前孩子的档案 > 本页兜底。
   * 诊断页改过的年级/册次会存进同一份状态，这里直接接着用，不另记一套。 */
  function currentScope() {
    var sc = SC ? SC.get(ST.subject) : null;
    if (sc && sc.grade) return sc;
    var g = String(ST.grade || '').trim();
    if (g) return { grade: SC ? SC.shortGrade(g) : g, term: ST.term || '', manual: false };
    return null;
  }

  /* 档案里被判为薄弱/不稳的点，弱在前、新的在前 */
  function candidates() {
    if (!ST.child || !CC || !ST.data) return [];
    var st = CC.latestStatus(ST.child.id, ST.subject);
    var out = [];
    Object.keys(st).forEach(function (id) {
      var v = st[id];
      if (!v || (v.status !== 'weak' && v.status !== 'shaky')) return;
      var t = ST.data.byId[id];
      if (!t || t.external) return;
      if (subjectOf(t) !== ST.subject) return;
      out.push({ id: id, status: v.status, at: v.at, topic: t });
    });
    out.sort(function (a, b) {
      var ra = a.status === 'weak' ? 0 : 1;
      var rb = b.status === 'weak' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return String(b.at || '').localeCompare(String(a.at || ''));
    });
    return out;
  }

  function topicOf(id) { return (ST.data && ST.data.byId[id]) || null; }

  /* 一个点都没选时不拦人：有档案就用档案里的薄弱点，没有就随机抽本册几个点拼综合题。
     force=true 是「换一组」。 */
  function ensureTargets(force) {
    ST.swapNote = '';
    if (force) { ST.picked = []; ST.pickOrigin = ''; }
    else if (ST.picked.length) return;

    var c = candidates().slice(0, MAX_PICK);
    if (c.length) {
      ST.picked = c.map(function (x) { return x.id; });
      ST.pickOrigin = 'weak';
      return;
    }
    var pool = topicsInBook(currentBook());
    if (!pool.length) pool = topicsOfSubject();
    ST.picked = sampleSpread(pool, 3).map(function (t) { return t.id; });
    ST.pickOrigin = ST.picked.length ? 'auto' : '';
  }
  function autoPickIfEmpty() { ensureTargets(false); }

  function togglePick(id) {
    var i = ST.picked.indexOf(id);
    if (i >= 0) { ST.picked.splice(i, 1); return ''; }
    if (ST.picked.length >= MAX_PICK) return '最多同时考察 ' + MAX_PICK + ' 个知识点，先取消一个。';
    ST.picked.push(id);
    return '';
  }

  /* 加一个点；已经满 MAX_PICK 时换掉最早选的那个。
     满了也不能把控件变灰——点不动的框会被当成坏了。 */
  function pickOrSwap(id) {
    ST.swapNote = '';
    if (ST.picked.indexOf(id) >= 0) {
      togglePick(id);
    } else if (ST.picked.length >= MAX_PICK) {
      var out = ST.picked.shift();
      ST.picked.push(id);
      var ot = topicOf(out), nt = topicOf(id);
      ST.swapNote = '已满 ' + MAX_PICK + ' 个，把「' + (ot ? ot.name : out) + '」换成了「'
        + (nt ? nt.name : id) + '」。';
    } else {
      ST.picked.push(id);
    }
    ST.err = '';
    ST.pickOrigin = ST.picked.length ? 'user' : '';
  }

  /* ---------------------------------------------------------------- 顶部 */

  function renderHead() {
    clear(headEl);
    var meta = h('div', { class: 'rv-head-meta' });
    if (ST.child) {
      meta.appendChild(pill(ST.child.name + ' · ' + childGrade(), 'blue'));
      meta.appendChild(pill(PR.SUBJECT_NAME[ST.subject] || '数学', 'gray'));
    } else {
      meta.appendChild(pill('未建档', 'amber'));
      meta.appendChild(pill(PR.SUBJECT_NAME[ST.subject] || '数学', 'gray'));
    }
    if (LLM.isWeb()) meta.appendChild(pill('网页版', 'gray'));
    headEl.appendChild(h('div', { class: 'rv-head' }, [
      h('div', { class: 'rv-head-copy' }, [
        h('h1', { text: '复习与考察' }),
        h('p', { class: 'lede', text: '挑出薄弱知识点，让模型出一套低、中、高三档的题；做完客观题当场判，解答题逐点给分。' })
      ]),
      meta
    ]));
  }

  /* ---------------------------------------------------------------- 左栏 */

  function renderSide() {
    clear(sideEl);

    sideEl.appendChild(targetPanel());
    sideEl.appendChild(topicPanel());
    sideEl.appendChild(settingPanel());
    sideEl.appendChild(histPanel());
  }

  /* 没建档案时自己选年级和学期：写进全站共享状态，诊断页也跟着变 */
  function scopeFields() {
    var cur = currentScope() || { grade: '四', term: '' };
    var seniorOf = function (k) { return ['高一', '高二', '高三'].indexOf(SC ? SC.fullGrade(k) : k) >= 0; };

    var gradeS = h('select', { class: 'rv-select', 'aria-label': '年级' });
    GRADES.forEach(function (g) {
      var k = SC ? SC.shortGrade(g) : g;
      gradeS.appendChild(h('option', { value: k, text: g, selected: k === cur.grade ? true : null }));
    });

    var termS = h('select', { class: 'rv-select', 'aria-label': '学期' });
    [['', '整个学年'], ['上', '上学期'], ['下', '下学期']].forEach(function (t) {
      termS.appendChild(h('option', { value: t[0], text: t[1], selected: (cur.term || '') === t[0] ? true : null }));
    });
    termS.disabled = seniorOf(cur.grade);

    function push() {
      if (SC) SC.set(ST.subject, { grade: gradeS.value, term: termS.value });
      ST.grade = SC ? SC.fullGrade(gradeS.value) : gradeS.value;
      ST.term = termS.value;
      render();
    }
    gradeS.addEventListener('change', function () {
      if (seniorOf(gradeS.value)) termS.value = '';
      push();
    });
    termS.addEventListener('change', push);

    return h('div', { class: 'rv-scope' }, [
      h('div', { class: 'rv-scope-row' }, [
        h('label', { class: 'rv-field rv-field-col' }, [h('span', { class: 'rv-label', text: '年级' }), gradeS]),
        h('label', { class: 'rv-field rv-field-col' }, [h('span', { class: 'rv-label', text: '学期' }), termS])
      ]),
      h('p', { class: 'rv-hint' }, [
        h('a', { class: 'rv-link', href: '../children/', text: '建一份档案' }),
        document.createTextNode(' 后，薄弱点会自动带出来。')
      ])
    ]);
  }

  function targetPanel() {
    var p = h('div', { class: 'pt-panel rv-panel' });
    p.appendChild(h('div', { class: 'pt-panel-head' }, [h('h2', { text: '考察对象' })]));
    var body = h('div', { class: 'pt-panel-body' });

    body.appendChild(subjectField());

    if (ST.child) {
      var sc0 = currentScope();
      var manualScope = !!(sc0 && sc0.manual);
      body.appendChild(h('div', { class: 'rv-child' }, [
        h('span', { class: 'rv-avatar', text: Array.from(ST.child.name)[0] || '·' }),
        h('div', { class: 'rv-child-main' }, [
          h('b', { text: ST.child.name }),
          h('em', { text: childGrade() + ' · ' + (ST.child.textbook || '人教版') })
        ]),
        h('a', { class: 'rv-link', href: '../children/', text: '换孩子' })
      ]));
      /* 诊断页手动改过范围：这儿跟着用，但要说清不是档案里的年级 */
      if (manualScope) {
        body.appendChild(h('p', { class: 'rv-hint is-warn' }, [
          document.createTextNode('诊断页手动选的，档案里是' + CC.gradeText(ST.child) + '。 '),
          h('button', {
            type: 'button', class: 'rv-linkbtn',
            onclick: function () { if (SC) SC.clear(ST.subject); render(); }
          }, ['回到档案'])
        ]));
      }
    } else {
      body.appendChild(h('div', { class: 'rv-anon' }, [scopeFields()]));
    }
    p.appendChild(body);
    return p;
  }

  /* 学科是这一页的总开关：换学科，选中的知识点、卷子、答案都得跟着换 */
  function subjectField() {
    var wrap = h('div', { class: 'rv-field rv-field-col rv-subjfield' });
    wrap.appendChild(h('span', { class: 'rv-label', text: '学科' }));
    var row = h('div', { class: 'rv-subj', role: 'group', 'aria-label': '学科' });
    ['math', 'chinese', 'english', 'physics'].forEach(function (k) {
      row.appendChild(h('button', {
        type: 'button',
        class: 'rv-subj-item' + (ST.subject === k ? ' is-on' : ''),
        'aria-pressed': ST.subject === k ? 'true' : 'false',
        text: PR.SUBJECT_NAME[k] || k,
        onclick: function () { switchSubject(k); }
      }));
    });
    wrap.appendChild(row);
    return wrap;
  }

  function switchSubject(next) {
    if (!next || next === ST.subject) return;
    ST.subject = next;
    ST.picked = [];
    ST.q = '';
    ST.set = null;
    ST.answers = {};
    ST.photos = {};
    ST.grade2 = null;
    ST.gradeErr = '';
    ST.photoNote = '';
    ST.err = '';
    if (SC) SC.setSubject(next);
    savePrefs();
    /* 地址栏跟着变，刷新或分享出去还是这个学科 */
    try {
      var u = new URL(location.href);
      if (next === 'math') u.searchParams.delete('subject');
      else u.searchParams.set('subject', next);
      history.replaceState(null, '', u.pathname + u.search);
    } catch (e) {}
    autoPickIfEmpty();
    render();
  }

  function topicPanel() {
    var p = h('div', { class: 'pt-panel rv-panel' });
    var head = h('div', { class: 'pt-panel-head' }, [
      h('h2', { text: '考察哪几个点' }),
      h('button', {
        type: 'button', class: 'rv-mini',
        text: ST.showPicker ? '收起' : '搜全学科',
        onclick: function () { ST.showPicker = !ST.showPicker; renderSide(); }
      })
    ]);
    p.appendChild(head);

    var body = h('div', { class: 'pt-panel-body' });

    /* 两个下拉：先按年级学期选册，再按章节挑知识点；挑几次就是多选 */
    var list = books();
    var bookNow = currentBook();

    var bookSel = h('select', { class: 'rv-select', 'aria-label': '册次' });
    if (!list.length) {
      bookSel.appendChild(h('option', { value: '', text: '知识点还没加载出来' }));
    }
    list.forEach(function (b) {
      bookSel.appendChild(h('option', {
        value: b.label, text: b.label + '（' + b.count + ' 个点）',
        selected: b.label === bookNow ? true : null
      }));
    });
    bookSel.addEventListener('change', function () {
      ST.book = bookSel.value;
      ST.picked = [];
      ST.pickOrigin = '';
      ensureTargets(false);
      render();
    });

    var full = ST.picked.length >= MAX_PICK;
    var addSel = h('select', {
      class: 'rv-select' + (full ? ' is-full' : ''),
      'aria-label': full ? '换一个知识点' : '加一个知识点'
    });
    /* 满了也不禁用：禁用会变成一个点不动的灰框，家长只会以为是坏了 */
    addSel.appendChild(h('option', {
      value: '',
      text: full ? '已选满 ' + MAX_PICK + ' 个 · 再选会换掉最早那个' : '加一个知识点（可多选）'
    }));
    var groups = {}, order = [];
    topicsInBook(bookNow).forEach(function (t) {
      var g = shortChapter(t.chapter) || '其他';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(t);
    });
    order.forEach(function (g) {
      var og = h('optgroup', { label: g });
      groups[g].forEach(function (t) {
        og.appendChild(h('option', { value: t.id, text: t.name + (ST.picked.indexOf(t.id) >= 0 ? '（已选）' : '') }));
      });
      addSel.appendChild(og);
    });
    addSel.title = full
      ? '最多同时考察 ' + MAX_PICK + ' 个知识点，再选一个会换掉最早那个'
      : '可以连着选，最多 ' + MAX_PICK + ' 个';
    addSel.addEventListener('change', function () {
      var id = addSel.value;
      addSel.value = '';
      if (!id) return;
      pickOrSwap(id);
      render();
    });

    body.appendChild(h('div', { class: 'rv-bookrow' }, [bookSel, addSel]));

    if (ST.picked.length) {
      var chosen = h('div', { class: 'rv-chosen' });
      var label = '已选 ' + ST.picked.length + ' / ' + MAX_PICK;
      if (ST.picked.length > 1) label += ' · 拼成一套综合题';
      chosen.appendChild(h('span', { class: 'rv-label', text: label }));
      var chips = h('div', { class: 'rv-chips' });
      ST.picked.forEach(function (id) {
        var t = topicOf(id);
        chips.appendChild(h('span', { class: 'rv-chip' }, [
          h('span', { text: t ? t.name : id }),
          h('button', {
            type: 'button', class: 'rv-chip-x', 'aria-label': '移除', text: '×',
            onclick: function () {
              togglePick(id);
              ST.swapNote = '';
              ST.pickOrigin = ST.picked.length ? 'user' : '';
              render();
            }
          })
        ]));
      });
      chosen.appendChild(chips);
      body.appendChild(chosen);
    }

    /* 这一次的点是怎么来的，说清楚，别让人以为是自己选的 */
    var note = h('p', { class: 'rv-hint' });
    if (ST.pickOrigin === 'weak') {
      note.appendChild(document.createTextNode('这 ' + ST.picked.length + ' 个点是档案里还没过关的。'));
    } else if (ST.pickOrigin === 'auto') {
      note.appendChild(document.createTextNode('档案里还没有薄弱点记录，从「' + (bookNow || '本学科') + '」随机抽了 ' + ST.picked.length + ' 个点，拼成一套综合题。 '));
      note.appendChild(h('button', {
        type: 'button', class: 'rv-mini', text: '换一组',
        onclick: function () { ensureTargets(true); render(); }
      }));
    } else if (ST.picked.length) {
      note.appendChild(document.createTextNode(ST.swapNote || ('自己挑的 ' + ST.picked.length + ' 个点。')));
    } else {
      note.appendChild(document.createTextNode('不选也能出题：有档案就用档案里的薄弱点，没有就随机抽几个本册的点。'));
    }
    body.appendChild(note);

    if (ST.showPicker) body.appendChild(pickerBox());

    p.appendChild(body);
    return p;
  }

  function topicRow(t, status, withMeta) {
    var on = ST.picked.indexOf(t.id) >= 0;
    var body = h('span', { class: 'rv-topic-body' }, [
      h('span', { class: 'rv-topic-name', text: t.name }),
      h('span', { class: 'rv-topic-meta', text: shortChapter(t.chapter) })
    ]);
    var row = h('button', {
      type: 'button',
      class: 'rv-topic' + (on ? ' is-on' : '') + (withMeta ? ' has-meta' : ''),
      onclick: function () {
        pickOrSwap(t.id);
        render();
      }
    }, [body]);
    if (status) {
      row.appendChild(h('span', {
        class: 'pt-pill is-' + (status === 'weak' ? 'red' : 'amber') + ' rv-topic-tag',
        text: status === 'weak' ? '薄弱' : '不稳'
      }));
    } else {
      row.appendChild(h('span', { class: 'pt-pill is-gray rv-topic-tag', text: '自选' }));
    }
    return row;
  }

  function shortChapter(ch) {
    var s = String(ch || '');
    var m = s.match(/第\s*\d+\s*单元[^，,]*/);
    if (m) return m[0];
    return s.length > 18 ? Array.from(s).slice(0, 17).join('') + '…' : s;
  }

  function pickerBox() {
    var box = h('div', { class: 'rv-picker' });
    var input = h('input', {
      type: 'search', class: 'rv-input', placeholder: '搜知识点名或章节，如 小数乘法',
      value: ST.q, 'aria-label': '搜索知识点'
    });
    var out = h('div', { class: 'rv-results', id: 'rv-results' });
    input.addEventListener('input', function () {
      ST.q = input.value;
      paintResults(out);
    });
    box.appendChild(input);
    box.appendChild(out);
    paintResults(out);
    return box;
  }

  function paintResults(box) {
    clear(box);
    if (!ST.data) return;
    var q = ST.q.trim().toLowerCase();
    if (!q) {
      box.appendChild(h('p', { class: 'rv-hint', text: '输入关键词，从本学科 ' + topicsOfSubject().length + ' 个知识点里找。' }));
      return;
    }
    var hit = [];
    var all = topicsOfSubject();
    for (var i = 0; i < all.length && hit.length < 8; i++) {
      var t = all[i];
      var hay = (t.name + ' ' + (t.chapter || '')).toLowerCase();
      if (hay.indexOf(q) >= 0) hit.push(t);
    }
    if (!hit.length) {
      box.appendChild(h('p', { class: 'rv-hint', text: '没找到，换个词试试。' }));
      return;
    }
    box.appendChild(h('span', { class: 'rv-label', text: '找到 ' + hit.length + ' 个，点一下加入' }));
    hit.forEach(function (t) { box.appendChild(topicRow(t, null, true)); });
  }

  function settingPanel() {
    var p = h('div', { class: 'pt-panel rv-panel' });
    p.appendChild(h('div', { class: 'pt-panel-head' }, [h('h2', { text: '出题设置' })]));
    var body = h('div', { class: 'pt-panel-body' });

    /* 每档题数 */
    var seg = h('div', { class: 'pt-seg rv-seg', role: 'group', 'aria-label': '每档题数' });
    [1, 2].forEach(function (n) {
      seg.appendChild(h('button', {
        type: 'button', class: ST.count === n ? 'on' : '',
        text: n + ' 题',
        onclick: function () { ST.count = n; savePrefs(); render(); }
      }));
    });
    body.appendChild(h('div', { class: 'rv-field' }, [
      h('span', { class: 'rv-label', text: '每档题数' }),
      seg
    ]));
    body.appendChild(h('p', {
      class: 'rv-hint',
      text: '低 / 中 / 高三档各 ' + ST.count + ' 题，共 ' + (ST.count * 3) + ' 题。选择题 + 填空 + 解答各一档。'
    }));

    /* 通道放在明面上：换到网页版是家长会主动找的动作，别藏在折叠里 */
    var chan = channelField();
    chan.classList.add('rv-chanfield');
    body.appendChild(chan);

    /* 高级：模型 / 凭据 / 联网 */
    var det = h('details', { class: 'rv-adv' });
    if (ST.advanced) det.setAttribute('open', '');
    det.addEventListener('toggle', function () { ST.advanced = det.open; savePrefs(); });
    det.appendChild(h('summary', null, [document.createTextNode(
      LLM.isWeb() ? '网页版凭据' : '模型与联网素材'
    )]));

    var inner = h('div', { class: 'rv-adv-body' });
    if (LLM.isWeb()) {
      inner.appendChild(webCfgField());
      if (LLM.WEB_MODELS.length > 1) inner.appendChild(webModelField());
    } else {
      inner.appendChild(modelField());
      /* 联网素材靠抓网页/搜索源，网页版自己有搜索，不需要这一套 */
      inner.appendChild(webField());
    }
    det.appendChild(inner);
    body.appendChild(det);

    /* 整册摸底：不挑点，按考察范围一个点一个点现出题，走诊断那套「掌握/不稳/薄弱」判定。
       这个入口的意义是把「题库不行」这条短路掉：题由模型按孩子档案现命。 */
    if (LLM.available()) {
      body.appendChild(h('div', { class: 'rv-whole' }, [
        h('p', { class: 'rv-hint', text: '不想挑点：按当前考察范围逐个知识点现出题，像单元测一样从头做到尾，判定结果同样进档案。' }),
        h('a', { class: 'rv-btn rv-btn-narrow', href: '../diagnose/?mode=grade&ai=1', text: '整册摸底 · AI 逐点出题' })
      ]));
    }

    p.appendChild(body);
    return p;
  }

  /* 通道：云端（免密钥，只能发文字）/ 网页版（自己的账号，能传照片） */
  function channelField() {
    var wrap = h('div', { class: 'rv-field rv-field-col' });
    wrap.appendChild(h('span', { class: 'rv-label', text: '出题通道' }));
    var seg = h('div', { class: 'pt-seg rv-seg rv-chan', role: 'group', 'aria-label': '出题通道' });
    [['cloud', '云端'], ['web', '网页版']].forEach(function (k) {
      var on = LLM.isWeb() === (k[0] === 'web');
      seg.appendChild(h('button', {
        type: 'button', class: on ? 'on' : '', text: k[1],
        'aria-pressed': on ? 'true' : 'false',
        onclick: function () { switchChannel(k[0]); }
      }));
    });
    wrap.appendChild(seg);
    wrap.appendChild(h('p', {
      class: 'rv-hint',
      text: LLM.isWeb()
        ? '走你自己的 DeepSeek 网页账号，自带联网搜索与深度思考，手写照片也能一起判。'
        : '免密钥，稳定；只能发文字，不能传照片。'
    }));
    return wrap;
  }

  function switchChannel(kind) {
    if (LLM.isWeb() === (kind === 'web')) return;
    LLM.setWeb({ kind: kind });
    ST.chanNote = '';
    ST.chanTone = '';
    if (kind === 'web') ST.advanced = true;
    savePrefs();
    ST.busy = 'models';
    ST.models = [];
    render();
    LLM.listModels().then(function (list) {
      ST.models = list;
      ST.modelsErr = '';
      if (!list.some(function (m) { return m.id === ST.model; })) {
        ST.model = LLM.pickDefault(list);
      }
      if (LLM.isWeb() && ST.model) LLM.setWeb({ model: ST.model });
      savePrefs();
    }).catch(function (e) {
      ST.modelsErr = LLM.describeError(e);
    }).then(function () {
      ST.busy = '';
      render();
    });
  }

  function webModelField() {
    var wrap = h('div', { class: 'rv-field rv-field-col' });
    wrap.appendChild(h('span', { class: 'rv-label', text: '出题模型' }));
    var sel = h('select', { class: 'rv-select', 'aria-label': '出题模型' });
    LLM.WEB_MODELS.forEach(function (m) {
      sel.appendChild(h('option', {
        value: m.id, text: m.name,
        selected: m.id === ST.model ? true : null
      }));
    });
    sel.addEventListener('change', function () {
      ST.model = sel.value;
      LLM.setWeb({ model: ST.model });
      savePrefs();
      renderSide();
    });
    wrap.appendChild(sel);
    var cur = LLM.WEB_MODELS.filter(function (m) { return m.id === ST.model; })[0];
    if (cur && cur.descriptionZh) wrap.appendChild(h('p', { class: 'rv-hint', text: cur.descriptionZh }));
    return wrap;
  }

  /* 网页版：家长只需要贴一条 curl。转发、端口这些都不露出来——普通用户看不懂，
     看到了只会以为要自己配。地址由 relayBase() 在后台决定（默认本站 /api/ds）。 */
  function webCfgField() {
    var cfg = LLM.web();
    var same = LLM.usingSiteRelay();
    var box = h('div', { class: 'rv-webcfg' });

    box.appendChild(h('p', {
      class: 'rv-hint',
      text: '网页版用的是 chat.deepseek.com 那个对话框：联网搜索和深度思考它自己开着，不用另配；这里只要贴一条登录凭据。'
    }));
    if (!same) {
      box.appendChild(h('p', {
        class: 'rv-hint is-warn',
        text: '网页版要走站点自带的转发，这个地址没有。用「启动.command」打开的页面来配，或者用发布后的网址。'
      }));
    }

    var ta = h('textarea', {
      class: 'rv-input rv-textarea rv-curl', rows: '3',
      placeholder: cfg.token
        ? '已保存凭据。要换就粘贴新的 curl 覆盖'
        : '在 chat.deepseek.com 的请求上右键 → 复制 → 以 cURL 格式复制，粘到这里',
      'aria-label': '登录凭据'
    });
    box.appendChild(h('label', { class: 'rv-field rv-field-col rv-field-tight' }, [
      h('span', { class: 'rv-label', text: '登录凭据（整条 curl 贴进来）' }), ta
    ]));

    var acts = h('div', { class: 'rv-webcfg-acts' });
    acts.appendChild(h('button', {
      type: 'button', class: 'rv-btn is-primary rv-btn-sm',
      text: cfg.token ? '换一条凭据' : '保存凭据',
      onclick: function () {
        var raw = String(ta.value || '').trim();
        if (!raw) {
          ST.chanNote = '先把 curl 粘进来。';
          ST.chanTone = 'is-warn';
          renderSide();
          return;
        }
        var got = LLM.parseCurl(raw);
        if (!got.token) {
          ST.chanNote = '没从这段里认出 userToken，重新复制一次完整的 curl。';
          ST.chanTone = 'is-warn';
          renderSide();
          return;
        }
        LLM.setWeb({ token: got.token, cookie: got.cookie, ua: got.ua, hdr: got.hdr });
        ST.chanNote = '';
        ST.chanTone = '';
        renderSide();
        testChannel(false);
      }
    }));
    acts.appendChild(h('button', {
      type: 'button', class: 'rv-btn rv-btn-sm', text: '测试连接',
      onclick: function () { testChannel(false); }
    }));
    acts.appendChild(h('button', {
      type: 'button', class: 'rv-btn rv-btn-sm', text: '连接诊断',
      onclick: function () { runSelfCheck(); }
    }));
    box.appendChild(acts);
    box.appendChild(h('div', { class: 'rv-diag' }));

    var note = h('p', { class: 'rv-hint' + (ST.chanTone ? ' ' + ST.chanTone : '') });
    note.textContent = ST.chanNote || (cfg.token
      ? '凭据存在这台设备的浏览器里' + (cfg.savedAt ? '（更新于 ' + fmtMin(cfg.savedAt) + '）' : '') + '，换设备要重贴。'
      : '还没配凭据。');
    box.appendChild(note);

    /* 第一次用的人卡在「curl 从哪来」，把这一步说清就够了，别再讲服务怎么起 */
    var how = h('details', { class: 'rv-howto' });
    how.appendChild(h('summary', null, [document.createTextNode('这条 curl 怎么复制（两步）')]));
    var ol = h('ol', { class: 'rv-howto-list' });
    [
      '浏览器打开 chat.deepseek.com，随便发一句话（登录状态要是好的）。',
      '按 F12 打开开发者工具 → 网络（Network）→ 找到那条 completion 请求 → 右键「复制 → 以 cURL 格式复制」，粘到上面保存。'
    ].forEach(function (x) { ol.appendChild(h('li', null, [h('span', { text: x })])); });
    how.appendChild(ol);
    how.appendChild(h('p', {
      class: 'rv-hint',
      text: '凭据只能用一段时间，过期了会弹窗提醒，重新复制一条粘进来即可。'
    }));
    box.appendChild(how);

    return box;
  }

  /* 一条条列出「页面在哪 / 转发指哪 / 健康检查 / 凭据认不认」，出问题不用猜 */
  function runSelfCheck() {
    var box = sideEl && sideEl.querySelector('.rv-diag');
    if (!box) return;
    box.textContent = '';
    box.appendChild(h('p', { class: 'rv-hint', text: '正在诊断…' }));
    LLM.selfCheck().then(function (steps) {
      box.textContent = '';
      (steps || []).forEach(function (s) {
        box.appendChild(h('div', { class: 'rv-diag-row' + (s.ok ? ' is-ok' : ' is-bad') }, [
          h('b', { text: (s.ok ? '✓ ' : '✗ ') + s.name }),
          h('span', { text: '  ' + s.detail })
        ]));
      });
    }).catch(function (e) {
      box.textContent = '';
      box.appendChild(h('p', { class: 'rv-hint is-warn', text: '诊断本身失败了：' + LLM.describeError(e) }));
    });
  }

  function testChannel(retried) {
    ST.chanNote = '正在测试…';
    ST.chanTone = '';
    renderSide();
    LLM.probe().then(function (j) {
      if (j && j.ok) {
        ST.chanNote = '连接正常' + (j.name ? ' · ' + j.name : '');
        ST.chanTone = 'is-ok';
      } else if (j && (j.code === 'token_invalid' || j.code === 'token_missing')) {
        ST.chanNote = j.code === 'token_missing'
          ? '还没贴凭据：把 chat.deepseek.com 的那条 curl 粘进来。'
          : '凭据无效或已过期，重新复制一条 curl 贴上。';
        ST.chanTone = 'is-warn';
        if (j.code === 'token_invalid') showCurlModal('DeepSeek 说这条凭据已经不能用了。');
      } else if (j && j.code === 'network') {
        ST.chanNote = '本机服务在，但连不上 chat.deepseek.com。' + (j.message ? '（' + j.message + '）' : '') + ' 检查网络或代理。';
        ST.chanTone = 'is-warn';
      } else if (j && j.env && (!j.env.node || !j.env.solver || !j.env.wasm)) {
        ST.chanNote = '本机缺 Node.js 或求解文件，网页版解不了挑战。';
        ST.chanTone = 'is-warn';
      } else {
        ST.chanNote = (j && j.message) || '自检没通过。';
        ST.chanTone = 'is-warn';
      }
    }).catch(function (e) {
      var code = (e && e.error && e.error.code) || '';
      if (code === 'web_offline' && !retried) {
        ST.chanNote = '正在重试…';
        ST.chanTone = 'is-warn';
        renderSide();
        /* 地址不往界面上露：自动探一遍就行，探到了悄悄用，探不到就说人话 */
        LLM.detectRelay().then(function (hit) {
          if (hit) {
            LLM.setWeb({ relay: hit.base });
            ST.chanNote = '';
            ST.chanTone = '';
            testChannel(true);
          } else {
            ST.chanNote = LLM.usingSiteRelay()
              ? '转发暂时没响应，等几秒再点一次；一直不行就刷新页面。'
              : '网页版要走站点自带的转发，这个页面没有。用「启动.command」打开页面，或者用发布后的网址。';
            ST.chanTone = 'is-warn';
            renderSide();
          }
        });
        return;
      }
      ST.chanNote = LLM.describeError(e);
      ST.chanTone = 'is-warn';
    }).then(function () {
      renderSide();
    });
  }

  function modelLabel(m) {
    var name = m.name || m.id;
    var cr = m.credits ? String(m.credits).replace(/\s*credits?/i, '') : '';
    return cr ? name + ' · ' + cr : name;
  }

  function modelField() {
    var wrap = h('div', { class: 'rv-field rv-field-col' });
    wrap.appendChild(h('span', { class: 'rv-label', text: '出题模型' }));
    if (ST.modelsErr) {
      wrap.appendChild(h('p', { class: 'rv-hint is-warn', text: ST.modelsErr }));
      return wrap;
    }
    if (!ST.models.length) {
      wrap.appendChild(h('p', { class: 'rv-hint', text: ST.busy === 'models' ? '读取模型列表…' : '正在读取…' }));
      return wrap;
    }
    var sel = h('select', { class: 'rv-select', 'aria-label': '出题模型' });
    var ds = ST.models.filter(function (m) { return LLM.isDeepSeek(m); });
    var rest = ST.models.filter(function (m) { return !LLM.isDeepSeek(m); });
    var addGroup = function (label, list) {
      if (!list.length) return;
      var g = h('optgroup', { label: label });
      list.forEach(function (m) {
        g.appendChild(h('option', { value: m.id, text: modelLabel(m), selected: m.id === ST.model ? true : null }));
      });
      sel.appendChild(g);
    };
    addGroup('DeepSeek', ds);
    addGroup('其他模型', rest);
    sel.addEventListener('change', function () { ST.model = sel.value; savePrefs(); renderSide(); });
    wrap.appendChild(sel);
    var cur = ST.models.filter(function (m) { return m.id === ST.model; })[0];
    if (cur && cur.descriptionZh) wrap.appendChild(h('p', { class: 'rv-hint', text: cur.descriptionZh }));
    return wrap;
  }

  function webField() {
    var wrap = h('div', { class: 'rv-field rv-field-col' });
    var row = h('label', { class: 'rv-switch' }, [
      h('input', {
        type: 'checkbox', checked: ST.webOn ? true : null,
        onchange: function (e) { ST.webOn = e.target.checked; savePrefs(); renderSide(); }
      }),
      h('span', { text: '联网找参考素材' })
    ]);
    wrap.appendChild(row);
    wrap.appendChild(h('p', {
      class: 'rv-hint',
      text: '只用来把握题型和常见易错，不作答案依据。'
    }));

    if (ST.webOn) {
      var ta = h('textarea', {
        class: 'rv-input rv-textarea', rows: '2',
        placeholder: '粘贴 1–3 个参考链接（可选），不填就按知识点自动搜',
        'aria-label': '参考链接'
      });
      ta.value = ST.links;
      ta.addEventListener('input', function () { ST.links = ta.value; savePrefs(); });
      wrap.appendChild(ta);

      var cfg = WEB.cfg();
      var note = h('p', { class: 'rv-hint' });
      if (!cfg.provider || !cfg.key) {
        note.appendChild(document.createTextNode('没配搜索源，只能抓上面粘贴的链接。'));
        note.appendChild(h('button', {
          type: 'button', class: 'rv-mini', text: '配搜索源',
          onclick: function () { ST.cfgOpen = !ST.cfgOpen; renderSide(); }
        }));
      } else {
        note.appendChild(document.createTextNode('搜索源：' + cfg.provider));
        note.appendChild(h('button', {
          type: 'button', class: 'rv-mini', text: '修改',
          onclick: function () { ST.cfgOpen = !ST.cfgOpen; renderSide(); }
        }));
      }
      wrap.appendChild(note);
      if (ST.cfgOpen) wrap.appendChild(searchCfgBox());
    }
    return wrap;
  }

  function searchCfgBox() {
    var cfg = WEB.cfg();
    var box = h('div', { class: 'rv-webcfg' });
    var prov = h('select', { class: 'rv-select rv-select-sm', 'aria-label': '搜索源' });
    [['tavily', 'Tavily'], ['serper', 'Serper']].forEach(function (p) {
      prov.appendChild(h('option', {
        value: p[0], text: p[1],
        selected: (cfg.provider || 'tavily') === p[0] ? true : null
      }));
    });
    var key = h('input', {
      type: 'password', class: 'rv-input rv-input-sm',
      placeholder: 'API Key（只存在这台设备上）',
      value: cfg.key || '', 'aria-label': '搜索 API Key'
    });
    box.appendChild(prov);
    box.appendChild(key);
    box.appendChild(h('div', { class: 'rv-webcfg-acts' }, [
      h('button', {
        type: 'button', class: 'rv-btn is-primary rv-btn-sm', text: '保存',
        onclick: function () {
          var v = key.value.trim();
          if (!v) { WEB.save({ provider: '', key: '' }); ST.cfgOpen = false; renderSide(); return; }
          WEB.save({ provider: prov.value, key: v });
          ST.cfgOpen = false;
          renderSide();
        }
      }),
      h('button', {
        type: 'button', class: 'rv-btn rv-btn-sm', text: '清除',
        onclick: function () { WEB.save({ provider: '', key: '' }); renderSide(); }
      })
    ]));
    box.appendChild(h('p', { class: 'rv-hint', text: '搜索源能跨域直连浏览器，key 只保存在本机，不上传。' }));
    return box;
  }

  function histPanel() {
    var arr = loadSets().filter(function (x) { return x.subject === ST.subject; }).slice(0, 4);
    if (!arr.length) return h('div');
    var p = h('div', { class: 'pt-panel rv-panel' });
    p.appendChild(h('div', { class: 'pt-panel-head' }, [h('h2', { text: '最近考察' })]));
    var body = h('div', { class: 'pt-panel-body rv-hist' });
    arr.forEach(function (row) {
      var sum = row.grade;
      var txt = sum ? (sum.score + ' / ' + sum.full + ' 分') : '未批改';
      body.appendChild(h('button', {
        type: 'button', class: 'rv-hist-row',
        onclick: function () { openSet(row); }
      }, [
        h('span', { class: 'rv-hist-main' }, [
          h('b', { text: row.title || '综合考察' }),
          h('em', { text: fmtMin(row.at) + ' · ' + (row.questions || []).length + ' 题' })
        ]),
        h('span', { class: 'rv-hist-score', text: txt })
      ]));
    });
    p.appendChild(body);
    return p;
  }

  function openSet(row) {
    ST.set = {
      id: row.id, at: row.at, title: row.title,
      topicIds: row.topicIds || [],
      questions: row.questions || [],
      savedToChild: !!row.savedToChild
    };
    ST.answers = row.answers || {};
    ST.photos = {};
    ST.photoNote = '';
    ST.grade2 = row.grade || null;
    ST.err = ''; ST.gradeErr = '';
    if (row.model) ST.model = row.model;
    render();
  }

  /* ---------------------------------------------------------------- 主区 */

  function renderStage() {
    clear(stageEl);

    if (!ST.data) {
      stageEl.appendChild(h('div', { class: 'pt-panel' }, [
        h('div', { class: 'pt-empty', text: '正在加载知识点…' })
      ]));
      return;
    }
    if (ST.busy === 'gen') { stageEl.appendChild(genPanel()); return; }
    if (ST.err) stageEl.appendChild(errorPanel(ST.err));

    if (!ST.set) { stageEl.appendChild(introPanel()); return; }

    if (ST.grade2) stageEl.appendChild(reportPanel());
    else stageEl.appendChild(quizHead());

    ST.set.questions.forEach(function (q, i) { stageEl.appendChild(questionCard(q, i)); });

    if (!ST.grade2) stageEl.appendChild(submitBar());
  }

  /* 这一套题会带上哪些上下文，写在开卷前，出问题好判断是数据不对还是模型不对 */
  function contextSummary(picks) {
    var bits = [];
    if (ST.child && CC) {
      var recs = CC.recordsOf(ST.child.id).filter(function (r) { return r.subject === ST.subject; });
      var diag = recs.filter(function (r) { return r.mode !== 'review'; });
      if (diag.length) bits.push('最近诊断 ' + (fmtMin(diag[0].savedAt) || '—'));
      if (recs.length) bits.push('档案 ' + recs.length + ' 次记录');
      var n = candidates().length;
      if (n) bits.push('待补 ' + n + ' 个点');
    }
    var sup = supportOf(picks);
    if (sup.length) bits.push('先修台阶 ' + sup.length + ' 个');
    return bits.length ? '这次出题会带上：' + bits.join(' · ') + '。' : '';
  }

  function introPanel() {
    var p = h('div', { class: 'pt-panel rv-intro' });
    var body = h('div', { class: 'pt-panel-body' });
    body.appendChild(h('div', { class: 'rv-intro-ico', html: ico('spark') }));

    var picks = ST.picked.map(function (id) { return topicOf(id); }).filter(Boolean);
    body.appendChild(h('h2', {
      class: 'rv-intro-title',
      text: picks.length
        ? '准备好了，出' + (ST.count * 3) + ' 道题' + (picks.length > 1 ? '（跨 ' + picks.length + ' 个点）' : '')
        : '先挑一个知识点'
    }));

    if (!picks.length) {
      body.appendChild(h('p', {
        class: 'rv-intro-text',
        text: ST.child
          ? '左边列出了档案里的薄弱点，点一下就能选中；也可以「自己选」搜任意知识点。'
          : '先从左边搜一个知识点：输入关键词，点一下加入，再回来生成题目。'
      }));
      var c = candidates();
      if (c.length) {
        body.appendChild(h('button', {
          type: 'button', class: 'rv-btn is-primary rv-btn-narrow',
          text: '选最薄弱的 3 个',
          onclick: function () { ST.picked = c.slice(0, 3).map(function (x) { return x.id; }); render(); }
        }));
      } else {
        body.appendChild(h('button', {
          type: 'button', class: 'rv-btn is-primary rv-btn-narrow',
          text: '搜索知识点',
          onclick: function () { ST.showPicker = true; renderSide(); focusSide(); }
        }));
      }
      p.appendChild(body);
      return p;
    }

    var list = h('div', { class: 'rv-intro-topics' });
    picks.forEach(function (t) {
      list.appendChild(h('span', { class: 'pt-pill is-blue', text: t.name }));
    });
    body.appendChild(list);

    var steps = h('div', { class: 'rv-steps' });
    [
      ['低', '基础巩固', '单选，考会不会'],
      ['中', '变式应用', '填空，考会不会用'],
      ['高', '综合迁移', '解答，考能不能迁移']
    ].forEach(function (s) {
      steps.appendChild(h('div', { class: 'rv-step' }, [
        h('span', { class: 'rv-step-k', text: s[0] }),
        h('b', { text: s[1] }),
        h('em', { text: s[2] })
      ]));
    });
    body.appendChild(steps);

    body.appendChild(h('p', { class: 'rv-intro-text', text: '每档 ' + ST.count + ' 题，共 ' + (ST.count * 3) + ' 题。选题在' + childGrade() + '范围内，模型会围绕这些点综合命题。' }));

    var ctxLine = contextSummary(picks);
    if (ctxLine) body.appendChild(h('p', { class: 'rv-hint', text: ctxLine }));

    /* 出问题时好判断是数据不对还是模型不对：把要发出去的画像摊开给人看 */
    var brief = h('details', { class: 'rv-brief' });
    brief.appendChild(h('summary', null, [document.createTextNode('这次命题的依据')]));
    var pre = h('pre', { class: 'rv-brief-pre' });
    var bt = [];
    var pb = PR.profileBlock(buildProfile(picks));
    var sb = PR.scopeBlock(buildScope(picks));
    if (pb) bt.push(pb);
    if (sb) bt.push(sb);
    pre.textContent = bt.join('\n\n') || '（没有档案，也没有先修数据，模型只知道年级和知识点）';
    brief.appendChild(pre);
    body.appendChild(brief);

    body.appendChild(h('button', {
      type: 'button', class: 'rv-btn is-primary',
      text: '生成这套题',
      onclick: generate
    }));
    p.appendChild(body);
    return p;
  }

  function genPanel() {
    var p = h('div', { class: 'pt-panel rv-gen' });
    var body = h('div', { class: 'pt-panel-body' });
    body.appendChild(h('div', { class: 'rv-gen-head' }, [
      h('span', { class: 'rv-spin' }),
      h('b', { text: ST.busyNote || '模型正在命题' })
    ]));
    body.appendChild(h('p', { class: 'rv-hint', text: '已接收 ' + ST.chars + ' 字。通常 20–60 秒，慢一点的模型会更久。' }));
    var bars = h('div', { class: 'rv-skel' });
    [92, 76, 88, 64].forEach(function (w) {
      bars.appendChild(h('span', { style: 'width:' + w + '%' }));
    });
    body.appendChild(bars);
    body.appendChild(h('button', {
      type: 'button', class: 'rv-btn is-ghost rv-btn-narrow',
      text: '取消',
      onclick: function () { if (abortCtl) abortCtl.abort(); }
    }));
    p.appendChild(body);
    return p;
  }

  function errorPanel(msg) {
    var p = h('div', { class: 'pt-panel rv-error' });
    p.appendChild(h('div', { class: 'pt-panel-body' }, [
      h('b', { text: '没成功' }),
      h('p', { class: 'rv-hint', text: msg })
    ]));
    return p;
  }

  function quizHead() {
    var p = h('div', { class: 'pt-panel rv-quizhead' });
    var answered = countAnswered();
    var total = ST.set.questions.length;
    var left = h('div', { class: 'rv-quizhead-main' }, [
      h('h2', { text: ST.set.title || '综合考察' }),
      h('p', { class: 'rv-hint', text: ST.set.topicIds.length + ' 个知识点 · ' + total + ' 题 · 已作答 ' + answered + ' / ' + total })
    ]);
    var bar = h('div', { class: 'pt-bar rv-progressbar' });
    bar.appendChild(h('i', { class: 'm', style: 'width:' + Math.round(answered / total * 100) + '%' }));
    var body = h('div', { class: 'pt-panel-body rv-quizhead-body' });
    body.appendChild(left);
    body.appendChild(bar);
    p.appendChild(body);
    return p;
  }

  function countAnswered() {
    return ST.set.questions.filter(function (q) { return isAnswered(q); }).length;
  }
  function isAnswered(q) {
    var v = ST.answers[q.id];
    if (q.type === 'choice') return v !== undefined && v !== null && v !== '';
    if (q.type === 'blank') return Array.isArray(v) && v.some(function (x) { return String(x || '').trim(); });
    if (ST.photos[q.id]) return true;
    return !!(v && String(v).trim());
  }

  function questionCard(q, idx) {
    var graded = ST.grade2 && ST.grade2.items[q.id];
    var card = h('article', { class: 'rv-q' + (graded ? ' is-graded' : '') });
    if (graded) {
      card.classList.add(graded.verdict === 'right' ? 'is-right' : graded.verdict === 'wrong' ? 'is-wrong' : 'is-partial');
    }

    var head = h('div', { class: 'rv-q-head' }, [
      h('span', { class: 'rv-q-no', text: ('0' + (idx + 1)).slice(-2) }),
      h('span', { class: 'pt-pill is-' + (q.level === 'low' ? 'blue' : q.level === 'mid' ? 'amber' : 'red'), text: LEVEL_NAME[q.level] || q.level }),
      h('span', { class: 'rv-q-topic', text: q.topicName || '' }),
      h('span', { class: 'rv-q-type', text: TYPE_NAME[q.type] || '' })
    ]);
    if (graded) {
      head.appendChild(h('span', {
        class: 'rv-q-score' + (graded.verdict === 'wrong' ? ' is-bad' : ''),
        text: graded.got + ' / ' + graded.full + ' 分'
      }));
    } else {
      head.appendChild(h('span', { class: 'rv-q-score is-muted', text: pointsOf(q) + ' 分' }));
    }
    card.appendChild(head);

    card.appendChild(h('p', { class: 'rv-q-stem', text: q.stem }));

    if (q.type === 'choice') card.appendChild(choiceBlock(q, graded));
    else if (q.type === 'blank') card.appendChild(blankBlock(q, graded));
    else card.appendChild(solutionBlock(q, graded));

    if (graded) card.appendChild(feedbackBlock(q, graded));
    return card;
  }

  function choiceBlock(q, graded) {
    var wrap = h('div', { class: 'rv-opts' });
    var chosen = ST.answers[q.id];
    (q.options || []).forEach(function (opt, i) {
      var cls = 'rv-opt';
      if (graded) {
        if (i === q.answerIndex) cls += ' is-answer';
        else if (Number(chosen) === i) cls += ' is-picked';
      } else if (Number(chosen) === i) cls += ' is-picked';
      var btn = h('button', {
        type: 'button', class: cls, disabled: graded ? true : null,
        onclick: function () { ST.answers[q.id] = i; render(); }
      }, [
        h('span', { class: 'rv-opt-k', text: 'ABCD'[i] || String(i + 1) }),
        h('span', { class: 'rv-opt-t', text: String(opt) })
      ]);
      wrap.appendChild(btn);
    });
    return wrap;
  }

  function blankBlock(q, graded) {
    var wrap = h('div', { class: 'rv-blanks' });
    var n = (q.blanks || []).length || 1;
    var vals = Array.isArray(ST.answers[q.id]) ? ST.answers[q.id] : [];
    var detail = graded && graded.detail ? graded.detail : null;

    for (var i = 0; i < n; i++) {
      (function (idx) {
        var cls = 'rv-input rv-blank';
        if (detail && detail[idx] !== undefined) cls += detail[idx] ? ' is-right' : ' is-wrong';
        var input = h('input', {
          type: 'text', class: cls,
          placeholder: n > 1 ? '第 ' + (idx + 1) + ' 空' : '填答案',
          value: vals[idx] || '',
          'aria-label': '第 ' + (idx + 1) + ' 空',
          disabled: graded ? true : null
        });
        input.addEventListener('input', function () {
          var arr = Array.isArray(ST.answers[q.id]) ? ST.answers[q.id].slice() : [];
          while (arr.length < n) arr.push('');
          arr[idx] = input.value;
          ST.answers[q.id] = arr;
        });
        wrap.appendChild(input);
      })(i);
    }
    return wrap;
  }

  function solutionBlock(q, graded) {
    var wrap = h('div', { class: 'rv-work' });
    var ta = h('textarea', {
      class: 'rv-input rv-textarea', rows: '5',
      placeholder: '写出你的过程和结论，也可以直接拍一张写在纸上的照片',
      'aria-label': '作答',
      disabled: graded ? true : null
    });
    ta.value = ST.answers[q.id] || '';
    ta.addEventListener('input', function () { ST.answers[q.id] = ta.value; });
    wrap.appendChild(ta);
    wrap.appendChild(photoRow(q, graded));
    return wrap;
  }

  /* 手写作业拍照：竖式、画图、几何证明在手机上打字太费劲 */
  function photoRow(q, graded) {
    var box = h('div', { class: 'rv-photo' });
    var pic = ST.photos[q.id];

    if (pic) {
      var capRow = h('figcaption', { class: 'rv-photo-cap' });
      capRow.appendChild(h('span', { text: graded ? '判分时看的这张照片' : '这张照片会和文字一起交给模型' }));
      if (!graded) {
        capRow.appendChild(h('button', {
          type: 'button', class: 'rv-photo-x', text: '重拍',
          'aria-label': '删除这张照片',
          onclick: function () { delete ST.photos[q.id]; render(); }
        }));
      }
      var fig = h('figure', { class: 'rv-photo-fig' }, [
        h('img', { src: pic.url, alt: '作答照片' }),
        capRow
      ]);
      box.appendChild(fig);
      return box;
    }
    if (graded) return h('div');

    var input = h('input', {
      type: 'file', accept: 'image/*', class: 'rv-photo-input', 'aria-label': '上传作答照片'
    });
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      readPhoto(f, function (pic2) {
        ST.photos[q.id] = pic2;
        ST.err = '';
        render();
      }, function (msg) {
        ST.err = msg;
        render();
      });
    });
    box.appendChild(h('label', { class: 'rv-photo-add' }, [
      h('span', { class: 'rv-photo-ico', html: cameraIco() }),
      h('span', { text: '拍照当答案' }),
      input
    ]));
    box.appendChild(h('p', { class: 'rv-hint', text: '手机上会直接开相机；写完拍一张，比打字快。' }));
    return box;
  }

  /* 照片压到长边 1400，JPEG 0.82：一张作业照约 200–400KB，传得动也看得清 */
  function readPhoto(file, ok, fail) {
    if (!file) return;
    if (!/^image\//.test(String(file.type || ''))) { fail('只支持图片文件。'); return; }
    if (file.size > 12 * 1024 * 1024) { fail('照片太大了（超过 12MB），重拍一张或先压缩。'); return; }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        var max = 1400;
        var w = img.naturalWidth || img.width;
        var hh = img.naturalHeight || img.height;
        var k = Math.min(1, max / Math.max(w, hh));
        var cw = Math.max(1, Math.round(w * k));
        var ch = Math.max(1, Math.round(hh * k));
        var cv = document.createElement('canvas');
        cv.width = cw;
        cv.height = ch;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        var data = cv.toDataURL('image/jpeg', 0.82);
        URL.revokeObjectURL(url);
        if (!data || data.length < 64) { fail('这张照片读不出来，换一张试试。'); return; }
        ok({ url: data, name: file.name || 'photo.jpg', w: cw, h: ch });
      } catch (e) {
        URL.revokeObjectURL(url);
        fail('照片处理失败，换一张试试。');
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      fail('这张照片读不出来，换一张试试。');
    };
    img.src = url;
  }

  function feedbackBlock(q, g) {
    var box = h('div', { class: 'rv-fb' });

    if (q.type === 'choice') {
      box.appendChild(h('p', { class: 'rv-fb-answer' }, [
        h('b', { text: '正确答案 ' }),
        h('span', { text: 'ABCD'[q.answerIndex] + '. ' + String((q.options || [])[q.answerIndex] || '') })
      ]));
      var mine = ST.answers[q.id];
      if (mine === undefined || mine === null || mine === '') {
        box.appendChild(h('p', { class: 'rv-fb-note', text: '这题空着没做。' }));
      }
    } else if (q.type === 'blank') {
      box.appendChild(h('p', { class: 'rv-fb-answer' }, [
        h('b', { text: '答案 ' }),
        h('span', { text: q.answerText || '' })
      ]));
    } else {
      if (g.hits && g.hits.length) {
        box.appendChild(h('div', { class: 'rv-fb-hits' }, [
          h('span', { class: 'rv-label', text: '做到了' }),
          h('ul', null, g.hits.map(function (x) { return h('li', { text: x }); }))
        ]));
      }
      if (g.miss && g.miss.length) {
        box.appendChild(h('div', { class: 'rv-fb-miss' }, [
          h('span', { class: 'rv-label', text: '漏了' }),
          h('ul', null, g.miss.map(function (x) { return h('li', { text: x }); }))
        ]));
      }
      if (!g.hits && !g.miss) {
        box.appendChild(h('p', { class: 'rv-fb-note', text: '这道题还没批改。' }));
      }
      if (q.answerText) {
        var det = h('details', { class: 'rv-fb-ref' });
        det.appendChild(h('summary', null, [document.createTextNode('参考答案')]));
        det.appendChild(h('p', { text: q.answerText }));
        box.appendChild(det);
      }
    }

    if (g.errorType) {
      var why = h('p', { class: 'rv-fb-why' });
      why.appendChild(pill(g.errorType, 'amber'));
      if (g.point) why.appendChild(h('span', { class: 'rv-fb-why-point', text: '卡在 ' + g.point }));
      box.appendChild(why);
    }
    if (g.comment) box.appendChild(h('p', { class: 'rv-fb-comment', text: g.comment }));
    if (q.explain) {
      box.appendChild(h('div', { class: 'rv-fb-explain' }, [
        h('span', { class: 'rv-label', text: '讲评' }),
        h('p', { text: q.explain })
      ]));
    }
    return box;
  }

  function submitBar() {
    var total = ST.set.questions.length;
    var left = total - countAnswered();
    var bar = h('div', { class: 'rv-submitbar' });
    var info = h('div', { class: 'rv-submit-info' });
    if (ST.gradeErr) {
      info.appendChild(h('p', { class: 'rv-hint is-warn', text: ST.gradeErr }));
    } else if (left > 0) {
      info.appendChild(h('p', { class: 'rv-hint', text: '还有 ' + left + ' 题没做，直接提交也可以，空题按 0 分算。' }));
    } else {
      info.appendChild(h('p', { class: 'rv-hint', text: '都做完了，提交批改。' }));
    }
    bar.appendChild(info);
    bar.appendChild(h('button', {
      type: 'button', class: 'rv-btn is-primary',
      text: ST.busy === 'grade' ? '批改中…' : (ST.gradeErr ? '重新批改' : '提交批改'),
      disabled: ST.busy === 'grade' ? true : null,
      onclick: submit
    }));
    return bar;
  }

  function reportPanel() {
    var g = ST.grade2;
    var p = h('div', { class: 'pt-panel rv-report' });
    var body = h('div', { class: 'pt-panel-body' });

    var head = h('div', { class: 'rv-report-head' });
    var ring = h('div', { class: 'pt-ring is-lg ' + toneClass(g.pct) });
    ring.style.setProperty('--p', String(Math.max(0, Math.min(100, Math.round(g.pct)))));
    ring.appendChild(h('span', { class: 'pt-ring-value', text: Math.round(g.pct) + '%' }));
    head.appendChild(ring);

    var summaryBox = h('div', { class: 'rv-report-summary' }, [
      h('h2', { text: g.title || '考察报告' }),
      h('p', { class: 'rv-report-total' }, [
        h('b', { text: String(g.score) }),
        document.createTextNode(' / ' + g.full + ' 分 · ' + verdictText(g.pct))
      ])
    ]);
    if (g.summary) summaryBox.appendChild(h('p', { class: 'rv-report-text', text: g.summary }));
    head.appendChild(summaryBox);
    body.appendChild(head);

    /* 三档分数 */
    var lv = h('div', { class: 'rv-levels' });
    (g.levels || []).forEach(function (l) {
      var pct = l.full ? l.got / l.full * 100 : 0;
      var cell = h('div', { class: 'rv-level' });
      cell.appendChild(h('div', { class: 'rv-level-top' }, [
        h('b', { text: LEVEL_FULL[l.key] || l.key }),
        h('span', { class: 'rv-level-num', text: l.got + '/' + l.full })
      ]));
      var bar = h('div', { class: 'pt-bar rv-level-bar' });
      bar.appendChild(h('i', { class: pct >= 85 ? 'm' : pct >= 60 ? 's' : 'w', style: 'width:' + pct + '%' }));
      cell.appendChild(bar);
      lv.appendChild(cell);
    });
    body.appendChild(lv);

    if (g.errs && g.errs.length) {
      /* 这里只说「错在哪一类」，具体的知识点留给下面的「还没过关」，避免两栏重复 */
      var ec = h('div', { class: 'rv-errs' });
      ec.appendChild(h('span', { class: 'rv-label', text: '错在哪' }));
      var echips = h('div', { class: 'rv-chips' });
      var tc = g.types || {};
      Object.keys(tc).sort(function (a, b) { return tc[b] - tc[a]; }).forEach(function (k) {
        echips.appendChild(h('span', { class: 'pt-pill is-amber', text: k + (tc[k] > 1 ? ' ×' + tc[k] : '') }));
      });
      ec.appendChild(echips);
      body.appendChild(ec);
    }
    if (g.gaps && g.gaps.length) {
      var gap = h('div', { class: 'rv-gaps' });
      gap.appendChild(h('span', { class: 'rv-label', text: '还没过关' }));
      var chips = h('div', { class: 'rv-chips' });
      g.gaps.forEach(function (x) { chips.appendChild(h('span', { class: 'pt-pill is-amber', text: x })); });
      gap.appendChild(chips);
      body.appendChild(gap);
    }
    if (g.next) {
      body.appendChild(h('div', { class: 'rv-next' }, [
        h('span', { class: 'rv-label', text: '下一步' }),
        h('p', { text: g.next })
      ]));
    }

    var acts = h('div', { class: 'rv-report-acts' });
    acts.appendChild(h('button', { type: 'button', class: 'rv-btn is-primary', text: '同知识点再来一套', onclick: function () { generate(); } }));
    acts.appendChild(h('button', {
      type: 'button', class: 'rv-btn', text: '登记到档案',
      disabled: (ST.child && !ST.set.savedToChild) ? null : true,
      onclick: saveToChild
    }));
    if (!ST.child) acts.appendChild(h('a', { class: 'rv-btn', href: '../children/', text: '先建档案' }));
    body.appendChild(acts);

    if (ST.child && ST.set.savedToChild) {
      body.appendChild(h('p', { class: 'rv-hint', text: '已登记到 ' + ST.child.name + ' 的档案。' }));
    }
    if (g.partial) {
      body.appendChild(h('p', { class: 'rv-hint is-warn', text: '这是部分结果：' + (ST.gradeErr || '解答题还没批改') + ' 客观题分数已算好，可以再点「提交批改」重试。' }));
    }
    if (ST.photoNote) {
      body.appendChild(h('p', { class: 'rv-hint is-warn', text: ST.photoNote }));
    }
    p.appendChild(body);
    return p;
  }

  function toneClass(pct) { return pct >= 85 ? 'tone-ok' : pct >= 60 ? 'tone-amber' : 'tone-bad'; }
  function verdictText(pct) {
    if (pct >= 85) return '过关';
    if (pct >= 60) return '需要巩固';
    return '还没过关';
  }

  /* ---------------------------------------------------------------- 判分 */

  var UNITS = ['平方米', '平方厘米', '平方分米', '立方米', '立方厘米', '千米', '公里', '厘米', '分米', '毫米',
    '千克', '公斤', '克', '吨', '毫升', '升', '分钟', '小时', '秒钟', '秒', '米', '元', '角', '分',
    '个', '人', '本', '支', '只', '块', '片', '天', '度', '°', '倍', '页', '次', '张'];

  function norm(s) {
    var t = String(s == null ? '' : s);
    var out = '';
    for (var i = 0; i < t.length; i++) {
      var c = t.charCodeAt(i);
      if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
      else out += t[i];
    }
    return out.toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[，。；：、,.;:!?！？"“”‘’]/g, '')
      .replace(/[（）()【】\[\]]/g, '')
      .replace(/[−–—]/g, '-')
      .replace(/^=/,'');
  }
  function stripUnit(s) {
    var t = norm(s);
    UNITS.forEach(function (u) { t = t.split(u).join(''); });
    return t;
  }
  function numOf(s) {
    var t = stripUnit(s).replace(/%$/, '');
    if (/^-?\d+\/-?\d+$/.test(t)) {
      var p = t.split('/');
      return Number(p[0]) / Number(p[1]);
    }
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return null;
  }
  function matchOne(accept, given) {
    var a = norm(accept), b = norm(given);
    if (!b) return false;
    if (a === b) return true;
    var sa = stripUnit(accept), sb = stripUnit(given);
    if (sa && sa === sb) return true;
    var na = numOf(accept), nb = numOf(given);
    if (na != null && nb != null && Math.abs(na - nb) < 1e-6) return true;
    return false;
  }
  function matchBlank(blank, given) {
    var list = (blank && blank.accept) || [];
    if (!list.length) return false;
    return list.some(function (x) { return matchOne(x, given); });
  }

  function pointsOf(q) {
    if (q.type === 'choice') return 3;
    if (q.type === 'blank') return Math.max(2, Math.min(4, ((q.blanks || []).length || 1) * 2));
    var sum = (q.rubric || []).reduce(function (a, r) { return a + (Number(r.score) || 0); }, 0);
    return Number(q.fullScore) || sum || 5;
  }

  /* ---------------------------------------------------------------- 出题 */

  function pickedTopics() {
    return ST.picked.map(function (id) { return topicOf(id); }).filter(Boolean);
  }

  function webQuery() {
    var names = pickedTopics().map(function (t) { return t.name; }).slice(0, 2);
    return [childGrade(), PR.SUBJECT_NAME[ST.subject] || '数学'].concat(names).join(' ') + ' 易错题 练习';
  }

  function parseLinks() {
    return String(ST.links || '')
      .split(/[\s,，;；\n]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+\//.test(s); })
      .slice(0, 3);
  }

  /* ------------------------------------------------------- 学情画像与范围 */

  /* 沿先修链回溯：[目标, 一级先修, 二级先修] 的名字 */
  function chainOf(id, depth) {
    var names = [], seen = {}, cur = id, guard = 0;
    var max = depth || 3;
    if (!ST.data) return names;
    while (cur && !seen[cur] && guard < max) {
      var t = topicOf(cur);
      if (!t) break;
      seen[cur] = true;
      names.push(t.name);
      var ps = (ST.data.prereq[cur] || []).filter(function (p) { return !!ST.data.byId[p]; });
      cur = ps.length ? ps[0] : '';
      guard++;
    }
    return names;
  }

  /* 两层以内的先修：给低档题当台阶用，本身不单独出题 */
  function supportOf(picks) {
    var out = [], seen = {}, skip = {};
    if (!ST.data) return out;
    picks.forEach(function (t) { skip[t.id] = true; });
    var level = picks.map(function (t) { return t.id; });
    for (var d = 0; d < 2 && level.length; d++) {
      var next = [];
      level.forEach(function (id) {
        (ST.data.prereq[id] || []).forEach(function (pid) {
          var pt = topicOf(pid);
          if (!pt || pt.external || seen[pid] || skip[pid]) return;
          if (subjectOf(pt) !== ST.subject) return;
          seen[pid] = true;
          out.push(pt.name);
          next.push(pid);
        });
      });
      level = next;
    }
    return out.slice(0, 8);
  }

  /* 把档案里的诊断记录整理成模型能读的画像：最近一次诊断、累计、问题点、先修链 */
  function buildProfile(picks) {
    var p = {
      grade: childGrade(), textbook: childTextbook(), subject: ST.subject,
      last: null, total: null, weak: [], chains: []
    };
    var recs = (ST.child && CC) ? CC.recordsOf(ST.child.id).filter(function (r) {
      return r.subject === ST.subject;
    }) : [];
    var diag = recs.filter(function (r) { return r.mode !== 'review'; });

    if (diag.length) {
      var r0 = diag[0], c0 = r0.counts || {};
      p.last = {
        when: fmtMin(r0.savedAt) || '—',
        label: String(r0.label || '诊断').slice(0, 20),
        asked: Number(r0.asked) || 0,
        weak: Number(c0.weak) || 0,
        shaky: Number(c0.shaky) || 0,
        mastered: Number(c0.mastered) || 0
      };
    }
    if (recs.length) {
      var tested = {}, nweak = 0, nshaky = 0;
      recs.forEach(function (r) {
        (r.weak || []).concat(r.shaky || [], r.mastered || []).forEach(function (id) { tested[id] = true; });
      });
      if (ST.child && CC) {
        var st = CC.latestStatus(ST.child.id, ST.subject) || {};
        Object.keys(st).forEach(function (id) {
          if (st[id].status === 'weak') nweak++;
          else if (st[id].status === 'shaky') nshaky++;
        });
      }
      p.total = { records: recs.length, tested: Object.keys(tested).length, weak: nweak, shaky: nshaky };
    }

    var cands = candidates();
    cands.slice(0, 6).forEach(function (c) {
      p.weak.push({ name: c.topic.name, chapter: shortChapter(c.topic.chapter) || '', status: c.status });
    });

    /* 先修链：本次目标在前，档案里其余问题点在后，去重，最多 5 条 */
    var seenChain = {};
    var addChain = function (id) {
      if (seenChain[id] || p.chains.length >= 5) return;
      seenChain[id] = true;
      var c = chainOf(id, 3);
      if (c.length > 1) p.chains.push(c);
    };
    picks.forEach(function (t) { addChain(t.id); });
    cands.forEach(function (c) { addChain(c.id); });

    return p;
  }

  function buildScope(picks) {
    return {
      targets: picks.map(function (t) { return t.name; }),
      support: supportOf(picks)
    };
  }

  function generate() {
    if (ST.busy) return;
    /* 一个点都没选也能出：先按「档案薄弱点 → 本册随机」补上，再出题 */
    if (!ST.picked.length) ensureTargets(false);
    var picks = pickedTopics();
    if (!picks.length) {
      ST.err = '知识点还没加载出来，等一秒再点。';
      render();
      return;
    }
    if (Date.now() - ST.lastGenAt < COOLDOWN_MS) {
      ST.err = '刚生成过，等几秒再出下一套。';
      render();
      return;
    }
    if (!LLM.available()) {
      ST.err = LLM.isWeb()
        ? '网页版通道还没配好：填好本机中转地址，再贴一条 chat.deepseek.com 的 curl。'
        : '云端模型通道没加载成功（网络或授权问题）。也可以展开「模型与联网素材」，把通道切到「网页版」用自己的账号。';
      render();
      return;
    }
    if (!ST.model) {
      ST.err = '模型列表还没读到，稍等一下再点。';
      render();
      return;
    }

    abortCtl = new AbortController();
    ST.busy = 'gen';
    ST.busyNote = '正在命题';
    ST.chars = 0;
    ST.err = '';
    ST.gradeErr = '';
    render();

    var wantWeb = !LLM.isWeb() && ST.webOn;
    var links = parseLinks();

    (async function () {
      var webItems = [];
      if (wantWeb) {
        ST.busyNote = links.length ? '正在抓取参考链接' : '正在检索参考素材';
        render();
        try {
          webItems = await WEB.collect({ links: links, query: links.length ? '' : webQuery() });
        } catch (e) { webItems = []; }
        if (webItems.length) ST.busyNote = '已取到 ' + webItems.length + ' 段素材，正在命题';
        else ST.busyNote = '没取到素材，直接命题';
        render();
      }

      var user = PR.setPrompt({
        grade: childGrade(),
        textbook: childTextbook(),
        subject: ST.subject,
        topics: picks.map(function (t) {
          var c = candidates().filter(function (x) { return x.id === t.id; })[0];
          return {
            id: t.id, name: t.name, chapter: t.chapter,
            description: t.description, mastery_criteria: t.mastery_criteria,
            state: c ? (c.status === 'weak' ? '薄弱' : '不稳') : ''
          };
        }),
        count: ST.count,
        synth: picks.length > 1,
        profile: buildProfile(picks),
        scope: buildScope(picks)
      });
      user += PR.webBlock(webItems);

      var text = await LLM.complete({
        model: ST.model,
        system: PR.SYSTEM,
        user: user,
        temperature: 0.8,
        signal: abortCtl.signal,
        onProgress: function (chars) {
          ST.chars = chars;
          var el = stageEl.querySelector('.rv-gen .rv-hint');
          if (el) el.textContent = '已接收 ' + chars + ' 字。通常 20–60 秒，慢一点的模型会更久。';
        }
      });

      var obj = LLM.parseJson(text);
      var qs = normalizeQuestions(obj);
      if (qs.length < 2) throw Object.assign(new Error('题目太少'), { error: { code: 'model_bad_json' } });

      ST.set = {
        id: uid(),
        at: new Date().toISOString(),
        title: String(obj.title || '').slice(0, 24) || (childGrade() + PR.SUBJECT_NAME[ST.subject] + '·综合考察'),
        topicIds: picks.map(function (t) { return t.id; }),
        questions: qs
      };
      ST.answers = {};
      ST.photos = {};
      ST.photoNote = '';
      ST.grade2 = null;
      ST.lastGenAt = Date.now();
      persistSet();
    })().catch(function (e) {
      ST.err = LLM.describeError(e);
    }).then(function () {
      ST.busy = '';
      abortCtl = null;
      render();
      focusStage();
    });
  }

  /* 手机上设置在上、题目在下：出完题把视线带到卷子 */
  function focusStage() {
    if (window.matchMedia('(max-width: 900px)').matches && stageEl) {
      try { stageEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
    }
  }
  function focusSide() {
    if (!sideEl) return;
    try { sideEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
    var input = sideEl.querySelector('.rv-picker input');
    if (input) input.focus({ preventScroll: true });
  }

  /* 把 "（1）20（2）50（3）够" 切成 ["20","50","够"]，用于补题干里多出来的空 */
  function splitAnswerText(t) {
    var s = String(t || '');
    return s
      .split(/(?:（\d+）|\(\d+\)|[①②③④⑤⑥⑦]|；|;|\n)/)
      .map(function (x) { return x.replace(/^[\s、,，:：]+/, '').replace(/[\s。.]+$/, '').trim(); })
      .filter(Boolean);
  }

  /* 模型输出不可信：逐题清洗，缺关键字段的直接丢掉 */
  function normalizeQuestions(obj) {
    var raw = (obj && obj.questions) || [];
    var out = [];
    var seen = {};
    raw.forEach(function (q) {
      if (!q || typeof q !== 'object') return;
      var stem = String(q.stem || '').trim();
      if (!stem) return;
      var level = ['low', 'mid', 'high'].indexOf(q.level) >= 0 ? q.level : 'mid';
      var type = q.type;
      if (type === 'choice') {
        var opts = (q.options || []).map(function (o) { return String(o == null ? '' : (o.text || o)).trim(); }).filter(Boolean);
        if (opts.length < 2) return;
        var ai = Number(q.answerIndex);
        if (!(ai >= 0 && ai < opts.length)) {
          var letter = String(q.answer || '').trim().toUpperCase().replace(/[^A-D]/g, '');
          ai = letter ? letter.charCodeAt(0) - 65 : -1;
          if (!(ai >= 0 && ai < opts.length)) return;
        }
        out.push({
          id: 'q' + (out.length + 1), topicId: String(q.topicId || ''), topicName: String(q.topicName || ''),
          level: level, type: 'choice', stem: stem, options: opts, answerIndex: ai,
          explain: String(q.explain || ''), rubric: []
        });
      } else if (type === 'blank') {
        var accepts = (q.blanks || []).map(function (b) {
          var acc = (b && b.accept) || [];
          if (!Array.isArray(acc)) acc = [acc];
          return acc.map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
        }).filter(function (a) { return a.length; });

        /* 题干里的空可能比 blanks 多：按题干补齐，答案从 answerText 里切出来 */
        var gaps = (stem.match(/_{2,}/g) || []).length;
        if (!accepts.length && !gaps) return;
        if (gaps > accepts.length) {
          var parts = splitAnswerText(q.answerText);
          for (var gi = accepts.length; gi < gaps && gi < 4; gi++) {
            accepts.push(parts[gi] ? [parts[gi]] : []);
          }
        }
        if (!accepts.length) accepts.push([]);

        out.push({
          id: 'q' + (out.length + 1), topicId: String(q.topicId || ''), topicName: String(q.topicName || ''),
          level: level, type: 'blank', stem: stem,
          blanks: accepts.slice(0, 4).map(function (a) { return { accept: a }; }),
          answerText: String(q.answerText || ''), explain: String(q.explain || ''),
          rubric: (q.rubric || []).map(function (r) { return { point: String(r.point || ''), score: Number(r.score) || 0 }; })
        });
      } else if (type === 'solution') {
        var rb = (q.rubric || []).map(function (r) {
          return { point: String(r.point || '').slice(0, 40), score: Number(r.score) || 0 };
        }).filter(function (r) { return r.point && r.score > 0; });
        var full = Number(q.fullScore) || rb.reduce(function (a, r) { return a + r.score; }, 0) || 5;
        if (!rb.length) rb = [{ point: '过程与结论', score: full }];
        out.push({
          id: 'q' + (out.length + 1), topicId: String(q.topicId || ''), topicName: String(q.topicName || ''),
          level: level, type: 'solution', stem: stem, answerText: String(q.answerText || ''),
          fullScore: full, rubric: rb, explain: String(q.explain || '')
        });
      }
    });
    /* 同一档最多留 count 题，档位顺序 低→中→高 */
    var order = { low: 0, mid: 1, high: 2 };
    var rank = function (lv) { return order[lv] === undefined ? 9 : order[lv]; };
    out.sort(function (a, b) { return rank(a.level) - rank(b.level); });
    var kept = [];
    var per = {};
    out.forEach(function (q) {
      per[q.level] = per[q.level] || 0;
      if (per[q.level] >= ST.count) return;
      per[q.level]++;
      kept.push(q);
    });
    kept.forEach(function (q, i) { q.id = 'q' + (i + 1); });
    return kept;
  }

  /* ---------------------------------------------------------------- 批改 */

  function cleanList(arr, n) {
    return (arr || []).map(function (x) { return String(x).replace(/\s+/g, ' ').trim().slice(0, 60); })
      .filter(Boolean).slice(0, n || 3);
  }

  /* 客观题写了什么，交给模型做错因归因；不含正确答案以外的提示 */
  function objectiveEvidence(q) {
    if (q.type === 'choice') {
      var v = ST.answers[q.id];
      if (v === undefined || v === null || v === '') return '未作答';
      var k = Number(v);
      var mine = String((q.options || [])[k] || '').slice(0, 40);
      return '选了 ' + ('ABCD'[k] || '?') + '. ' + mine +
        '；正确选项是 ' + ('ABCD'[q.answerIndex] || '?') + '. ' + String((q.options || [])[q.answerIndex] || '').slice(0, 40);
    }
    if (q.type === 'blank') {
      var arr = Array.isArray(ST.answers[q.id]) ? ST.answers[q.id] : [];
      var mine2 = arr.map(function (x, i) {
        return '第' + (i + 1) + '空写「' + String(x == null || x === '' ? '空' : x).slice(0, 20) + '」';
      }).join('、');
      return (mine2 || '未作答') + '；应填 ' + String(q.answerText || '').slice(0, 50);
    }
    return '';
  }

  function submit() {
    if (ST.busy) return;
    var qs = ST.set.questions;
    var items = {};

    qs.forEach(function (q) {
      var full = pointsOf(q);
      if (q.type === 'choice') {
        var v = ST.answers[q.id];
        var ok = v !== undefined && v !== null && Number(v) === Number(q.answerIndex);
        items[q.id] = { got: ok ? full : 0, full: full, verdict: ok ? 'right' : 'wrong' };
      } else if (q.type === 'blank') {
        var arr = Array.isArray(ST.answers[q.id]) ? ST.answers[q.id] : [];
        var n = q.blanks.length || 1;
        var per = full / n;
        var got = 0;
        var detail = q.blanks.map(function (b, i) {
          var good = matchBlank(b, arr[i]);
          if (good) got += per;
          return good;
        });
        var all = detail.every(Boolean);
        items[q.id] = {
          got: round1(got), full: full,
          verdict: all ? 'right' : got > 0 ? 'partial' : 'wrong',
          detail: detail
        };
      } else {
        items[q.id] = { got: 0, full: full, verdict: 'pending' };
      }
    });

    var subjective = qs.filter(function (q) { return q.type === 'solution'; });
    ST.busy = 'grade';
    ST.gradeErr = '';
    ST.photoNote = '';
    ST.busyNote = '正在批改';
    abortCtl = new AbortController();
    render();

    (async function () {
      var extra = { summary: '', gaps: [], next: '' };
      var missCount = qs.filter(function (q) { return items[q.id].verdict !== 'right'; }).length;
      /* 有解答题要判分，或者客观题有错要归因，都值得让模型看一遍；全对且无解答题就不花这次额度 */
      if (subjective.length || missCount) {
        /* 拍照作答的题：图片按题目顺序排，提示词里写清第几张图对应哪题 */
        var photoQs = subjective.filter(function (q) { return !!ST.photos[q.id]; });
        var images = photoQs.map(function (q) { return ST.photos[q.id].url; });
        var photoNo = {};
        photoQs.forEach(function (q, i) { photoNo[q.id] = i + 1; });

        var objective = qs.filter(function (q) { return q.type !== 'solution'; }).map(function (q) {
          return {
            id: q.id, level: LEVEL_NAME[q.level] || q.level, type: q.type,
            got: items[q.id].got, full: items[q.id].full, verdict: items[q.id].verdict,
            evidence: objectiveEvidence(q)
          };
        });
        var user = PR.gradePrompt({
          grade: childGrade(),
          subject: ST.subject,
          objective: objective,
          photoCount: images.length,
          subjective: subjective.map(function (q) {
            return {
              id: q.id, level: LEVEL_FULL[q.level] || q.level, stem: q.stem,
              answerText: q.answerText, rubric: q.rubric, fullScore: pointsOf(q),
              studentAnswer: ST.answers[q.id] || '',
              photo: photoNo[q.id] || 0
            };
          })
        });
        var text;
        try {
          text = await LLM.complete({
            model: ST.model, system: PR.SYSTEM, user: user,
            images: images, temperature: 0.2, signal: abortCtl.signal
          });
        } catch (e) {
          /* 云端不认图片时，退回文字结果，别让整张卷子判不了 */
          if (e && e.droppedImages && e.text) {
            text = e.text;
            ST.photoNote = '照片没被云端接收，这次只按文字批改。想拍照批改，把通道换成「网页版」。';
          } else {
            throw e;
          }
        }
        var obj = LLM.parseJson(text);
        (obj.items || []).forEach(function (it) {
          var q = qs.filter(function (x) { return x.id === it.id; })[0];
          if (!q || !items[it.id]) return;
          var row = items[it.id];
          /* 客观题的分由前端判，模型只负责归因，不许改分 */
          if (q.type === 'solution') {
            var score = Number(it.score);
            if (!isFinite(score)) score = 0;
            score = Math.max(0, Math.min(row.full, score));
            row.got = round1(score);
            row.verdict = score >= row.full ? 'right' : score > 0 ? 'partial' : 'wrong';
            row.hits = cleanList(it.hits, 4);
            row.miss = cleanList(it.miss, 4);
          }
          row.comment = String(it.comment || '').slice(0, 200);
          var et = PR.ERROR_CN[String(it.errorType || '')];
          row.errorType = (et && et !== '—' && row.verdict !== 'right') ? et : '';
          row.point = row.verdict === 'right' ? '' : String(it.point || '').replace(/\s+/g, ' ').trim().slice(0, 24);
        });
        extra.summary = String(obj.summary || '').slice(0, 400);
        extra.gaps = (obj.gaps || []).map(function (x) { return String(x).slice(0, 24); }).slice(0, 3);
        extra.next = String(obj.next || '').slice(0, 300);
      }
      finishGrade(items, extra);
    })().catch(function (e) {
      ST.gradeErr = LLM.describeError(e);
      finishGrade(items, { summary: '', gaps: [], next: '' });
    }).then(function () {
      ST.busy = '';
      abortCtl = null;
      render();
      if (ST.grade2) window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  function finishGrade(items, extra) {
    var qs = ST.set.questions;
    var score = 0, full = 0;
    var levels = ['low', 'mid', 'high'].map(function (k) {
      var got = 0, f = 0;
      qs.forEach(function (q) {
        if (q.level !== k) return;
        got += items[q.id].got;
        f += items[q.id].full;
      });
      return { key: k, got: round1(got), full: f };
    }).filter(function (l) { return l.full > 0; });
    levels.forEach(function (l) { score += l.got; full += l.full; });

    score = round1(score);
    var finalScore = score, finalFull = full;

    /* 逐题的错因归因收拢：报告里给一栏「错在哪」，档案里也留一份 */
    var errs = qs.filter(function (q) { return items[q.id] && items[q.id].errorType; })
      .map(function (q) {
        return {
          type: items[q.id].errorType,
          point: items[q.id].point || String(q.topicName || '').slice(0, 16)
        };
      }).slice(0, 6);
    var typeCount = {};
    errs.forEach(function (e) { typeCount[e.type] = (typeCount[e.type] || 0) + 1; });

    var summary = extra.summary;
    if (!summary) {
      /* 模型没给整体判断时，用三档分数拼一句实话，别留空 */
      summary = levels.map(function (l) {
        var p = l.full ? l.got / l.full : 0;
        return (LEVEL_FULL[l.key] || l.key) + ' ' + l.got + '/' + l.full + '（' + verdictText(p * 100) + '）';
      }).join('；') + '。';
      var top = Object.keys(typeCount).sort(function (a, b) { return typeCount[b] - typeCount[a]; })[0];
      if (top) summary += '主要错因是' + top + '。';
    }

    /* 模型没给「还没过关」时，用逐题归因出来的卡点补上，别让这一栏空着 */
    var gaps = (extra.gaps || []).filter(Boolean).slice(0, 3);
    if (!gaps.length) {
      var seenG = {};
      errs.forEach(function (e) {
        if (!e.point || seenG[e.point] || gaps.length >= 3) return;
        seenG[e.point] = true;
        gaps.push(e.point);
      });
    }

    ST.grade2 = {
      at: new Date().toISOString(),
      title: ST.set.title,
      items: items,
      score: finalScore,
      full: finalFull,
      pct: finalFull ? finalScore / finalFull * 100 : 0,
      levels: levels,
      summary: summary,
      gaps: gaps,
      next: extra.next,
      errs: errs,
      types: typeCount,
      partial: !!ST.gradeErr
    };
    ST.set.savedToChild = false;
    persistSet();
  }

  /* 考察结果进档案：只作记录，不改诊断得出的掌握状态 */
  function saveToChild() {
    if (!ST.child || !ST.grade2 || !CC) return;
    var g = ST.grade2;
    CC.saveRecord(ST.child.id, {
      key: 'rv:' + ST.set.id,
      subject: ST.subject,
      label: ST.set.title || '综合考察',
      mode: 'review',
      asked: ST.set.questions.length,
      partial: !!g.partial,
      targets: ST.set.topicIds.slice(0, 8),
      counts: { weak: 0, shaky: 0, mastered: 0, untested: 0 },
      weak: [], shaky: [], mastered: [], roots: [],
      review: {
        score: g.score, full: g.full, pct: Math.round(g.pct),
        levels: g.levels, gaps: g.gaps,
        errs: (g.errs || []).slice(0, 5), types: g.types || {}
      }
    });
    ST.set.savedToChild = true;
    persistSet();
    render();
  }

  /* ---------------------------------------------------------------- 渲染 */

  function withSubject(href) {
    if (ST.subject === 'math' || !href) return href;
    if (href.indexOf('subject=') >= 0 || href.indexOf('http') === 0) return href;
    return href + (href.indexOf('?') >= 0 ? '&' : '?') + 'subject=' + ST.subject;
  }

  /* 导航里的学科高亮与链接带上 subject，切学科后不丢上下文 */
  function applySubjectChrome() {
    var subj = ST.subject;
    document.body.classList.toggle('subject-english', subj === 'english');
    document.body.classList.toggle('subject-physics', subj === 'physics');
    document.body.classList.toggle('subject-chinese', subj === 'chinese');
    document.querySelectorAll('.site-nav a:not(.subject-link), a.brand').forEach(function (link) {
      var href = link.getAttribute('href');
      var next = withSubject(href);
      if (next && next !== href) link.setAttribute('href', next);
    });
    document.querySelectorAll('.subject-link').forEach(function (link) {
      var on = link.getAttribute('data-subject') === subj;
      link.classList.toggle('on', on);
      if (on) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  function render() {
    applySubjectChrome();
    renderHead();
    renderSide();
    renderStage();
  }

  function ico(name) {
    if (name === 'spark') {
      return '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2l1.9 4.6 4.6 1.9-4.6 1.9L12 16.2l-1.9-4.6L5.5 9.7l4.6-1.9z"/><path d="M18.4 15.6l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>';
    }
    return '';
  }

  function cameraIco() {
    return '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.3 4.4 8.4 3h3.2l1.1 1.4h2.2A1.9 1.9 0 0 1 16.8 6.3v7.2a1.9 1.9 0 0 1-1.9 1.9H5.1a1.9 1.9 0 0 1-1.9-1.9V6.3a1.9 1.9 0 0 1 1.9-1.9z"/><circle cx="10" cy="9.9" r="2.7"/></svg>';
  }

  /* ---------------------------------------------------------------- 启动 */

  /* 凭据失效不弹窗的话，用户只会看到「模型返回的格式不对」这种看不懂的错。
     这里给一个明确的弹窗：说清要干什么，一键跳到粘贴框。 */
  var modalEl = null;
  function showCurlModal(reason) {
    if (modalEl) return;
    var card = h('div', { class: 'rv-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rv-modal-title' }, [
      h('h2', { id: 'rv-modal-title', text: 'DeepSeek 凭据过期了' }),
      h('p', { class: 'rv-modal-text', text: (reason ? reason + ' ' : '') + '网页版的登录凭据只能用一段时间，过期后要重新从浏览器里复制一条。' }),
      h('ol', { class: 'rv-modal-steps' }, [
        h('li', { text: '在电脑上打开 chat.deepseek.com，随便发一句话。' }),
        h('li', { text: '在开发者工具的「网络」里找到 chat/completion 那条请求。' }),
        h('li', { text: '右键 → 复制 → 以 cURL 格式复制，粘到「网页版凭据」里保存。' })
      ]),
      h('div', { class: 'rv-modal-acts' }, [
        h('button', {
          type: 'button', class: 'rv-btn is-primary rv-btn-sm', text: '去粘贴新凭据',
          onclick: function () { closeCurlModal(); openCurlBox(); }
        }),
        h('button', {
          type: 'button', class: 'rv-btn rv-btn-sm', text: '先不用',
          onclick: closeCurlModal
        })
      ])
    ]);
    modalEl = h('div', { class: 'rv-modal', onclick: function (e) { if (e.target === modalEl) closeCurlModal(); } }, [card]);
    document.body.appendChild(modalEl);
    document.body.classList.add('has-modal');
    var first = modalEl.querySelector('button');
    if (first) first.focus();
    document.addEventListener('keydown', onModalKey);
  }
  function onModalKey(e) { if (e.key === 'Escape') closeCurlModal(); }
  function closeCurlModal() {
    if (!modalEl) return;
    document.removeEventListener('keydown', onModalKey);
    document.body.classList.remove('has-modal');
    modalEl.parentNode.removeChild(modalEl);
    modalEl = null;
  }
  function openCurlBox() {
    ST.advanced = true;
    ST.chanOpen = false;
    ST.chanNote = '把新复制的 curl 粘到下面，点「换一条凭据」。';
    ST.chanTone = 'is-warn';
    render();
    setTimeout(function () {
      var ta = sideEl && sideEl.querySelector('.rv-curl');
      if (ta) {
        ta.scrollIntoView({ block: 'center' });
        ta.focus({ preventScroll: true });
      }
    }, 60);
  }

  function boot() {
    loadPrefs();
    var qs = new URLSearchParams(location.search);
    var sub = qs.get('subject');
    if (sub === 'chinese' || sub === 'english' || sub === 'physics') ST.subject = sub;
    else if (SC && SC.subject()) ST.subject = SC.subject();   // 跟上「诊断」里最后用的学科
    /* 地址栏跟上，分享出去还是这个学科 */
    if (!sub && ST.subject !== 'math') {
      try {
        var u0 = new URL(location.href);
        u0.searchParams.set('subject', ST.subject);
        history.replaceState(null, '', u0.pathname + u0.search);
      } catch (e0) { /* ignore */ }
    }
    if (CC) {
      ST.child = CC.current();
      if (ST.child) {
        ST.grade = ST.child.grade || '';
        ST.term = ST.child.term || '';
        ST.textbook = ST.child.textbook || '';
      }
    }
    /* 选了网页版却还没凭据（换了设备 / 清了缓存）：把配置面板摊开，别让人找不到 */
    if (LLM.isWeb() && !LLM.web().token) ST.advanced = true;
    /* 凭据过期时不让人对着「格式不对」发呆，直接弹窗说清楚 */
    LLM.onAuthFail(showCurlModal);
    /* 老配置里存着 127.0.0.1:8790：这个地址本身带着 /api/ds 就自动升级成同站转发，
       省得人以为还要另外开一个中转。检查完再重绘一次。 */
    LLM.ensureRelay().then(function (changed) { if (changed) renderSide(); });
    render();

    loadData().then(function () {
      autoPickIfEmpty();
      render();
    }).catch(function (e) {
      ST.err = '知识点数据没加载出来：' + (e && e.message ? e.message : '未知错误');
      render();
    });

    ST.busy = 'models';
    LLM.listModels().then(function (list) {
      ST.models = list;
      ST.modelsErr = '';
      if (!ST.model || !list.some(function (m) { return m.id === ST.model; })) {
        ST.model = LLM.pickDefault(list);
      }
      if (LLM.isWeb() && ST.model) LLM.setWeb({ model: ST.model });
      if (ST.model) savePrefs();
    }).catch(function (e) {
      ST.modelsErr = LLM.describeError(e);
    }).then(function () {
      ST.busy = '';
      render();
    });
  }

  boot();
})();
