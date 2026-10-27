/* 孩子档案页：添加、编辑、删除孩子，切换当前孩子。数据来自 assets/children.js（localStorage）。 */
(function () {
  'use strict';
  var CC = window.CnmChildren;
  var SC = window.CnmScope;
  var listBox = document.getElementById('list');
  var form = document.getElementById('form');
  var nameIn = document.getElementById('f-name');
  var gradeSel = document.getElementById('f-grade');
  var termSel = document.getElementById('f-term');
  var termNote = document.getElementById('term-note');
  var bookSel = document.getElementById('f-book');
  var errBox = document.getElementById('f-error');
  var submitBtn = document.getElementById('f-submit');
  var cancelBtn = document.getElementById('f-cancel');
  var formTitle = document.getElementById('form-title');
  var editing = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fillSelect(sel, items, placeholder) {
    sel.textContent = '';
    if (placeholder) { var o = el('option', null, placeholder); o.value = ''; sel.appendChild(o); }
    items.forEach(function (x) { var o = el('option', null, x); o.value = x; sel.appendChild(o); });
  }
  /* 这几个常量以 children.js 为准，但页面可能跑在旧缓存的 children.js 上
     （Service Worker 换版本那一瞬间常见）。旧版没有 TERMS 会让下拉框整个空白，
     所以这里留一份兜底，至少框里是有字的。 */
  var GRADES = (CC && CC.GRADES) || ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级', '高一', '高二', '高三'];
  var TEXTBOOKS = (CC && CC.TEXTBOOKS) || ['人教版', '北师大版', '苏教版', '沪教版', '外研版', '译林版', '其他'];
  var TERMS = (CC && CC.TERMS) || [['上', '上学期（上册）'], ['下', '下学期（下册）'], ['', '整学年']];

  function fillPairs(sel, pairs) {
    sel.textContent = '';
    (pairs || []).forEach(function (p) { var o = el('option', null, p[1]); o.value = p[0]; sel.appendChild(o); });
  }
  fillSelect(gradeSel, GRADES, '请选择年级');
  fillPairs(termSel, TERMS);
  fillSelect(bookSel, TEXTBOOKS);

  /* 学期跟着年级变：没选年级给占位，高中按必修/选必分册直接锁掉 */
  function syncTerm(want) {
    var g = gradeSel.value;
    var senior = GRADES.indexOf(g) >= 9; // 高一 高二 高三
    var blank = !g;
    var v = want === undefined ? termSel.value : String(want);
    if (blank) {
      fillPairs(termSel, [['', '先选年级']]);
      termSel.value = '';
      termSel.disabled = true;
    } else if (senior) {
      fillPairs(termSel, [['', '不分上下学期']]);
      termSel.value = '';
      termSel.disabled = true;
    } else {
      var has = TERMS.some(function (t) { return t[0] === v; });
      fillPairs(termSel, TERMS);
      termSel.value = has ? v : '上';
      termSel.disabled = false;
    }
    termNote.textContent = senior
      ? '高中按必修 / 选必分册，不用选上下学期。'
      : '诊断、复习默认落在这一册的知识点上。';
  }
  gradeSel.addEventListener('change', function () {
    var g = gradeSel.value;
    syncTerm(g && GRADES.indexOf(g) < 9 ? '上' : '');
  });

  var params = new URLSearchParams(location.search);
  if (params.get('from') === 'diagnose') {
    var back = document.getElementById('back');
    var sub = params.get('subject');
    var href = '../diagnose/' + (sub === 'english' || sub === 'physics' || sub === 'chinese' ? '?subject=' + sub : '');
    var a = el('a', null, '← 回到诊断');
    a.href = href;
    back.appendChild(a);
    back.hidden = false;
  }

  function showError(msg) { errBox.textContent = msg || ''; errBox.hidden = !msg; }

  function resetForm() {
    editing = null;
    nameIn.value = '';
    gradeSel.value = '';
    syncTerm('');
    bookSel.value = TEXTBOOKS[0];
    formTitle.textContent = '添加孩子';
    submitBtn.textContent = '添加孩子';
    cancelBtn.hidden = true;
    showError('');
  }

  function startEdit(c) {
    editing = c.id;
    nameIn.value = c.name;
    gradeSel.value = c.grade;
    syncTerm(c.term || '');
    bookSel.value = c.textbook;
    formTitle.textContent = '修改「' + c.name + '」的信息';
    submitBtn.textContent = '保存修改';
    cancelBtn.hidden = false;
    showError('');
    document.getElementById('form-card').scrollIntoView({ block: 'center' });
    nameIn.focus();
  }

  /* 手动确认的掌握状态也是一条 record，但它不算一次诊断——计数、最近日期都要排掉 */
  function diagRecords(childId) {
    return CC.recordsOf(childId).filter(function (r) { return CC.isDiagRecord ? CC.isDiagRecord(r) : r.key !== 'manual:graph'; });
  }

  function stats(c) {
    var recs = diagRecords(c.id);
    var by = CC.latestStatus(c.id);
    var m = 0, s = 0, w = 0;
    Object.keys(by).forEach(function (id) {
      var st = by[id].status;
      if (st === 'mastered') m++; else if (st === 'shaky') s++; else if (st === 'weak') w++;
    });
    return { runs: recs.length, weak: w, m: m, s: s, w: w, tested: m + s + w };
  }

  /* 掌握率 = 已掌握 / 已测（掌握 + 不稳 + 薄弱），没有测试数据返回 null */
  function rateOf(c) {
    var by = CC.latestStatus(c.id);
    var m = 0, s = 0, w = 0;
    Object.keys(by).forEach(function (id) {
      var st = by[id].status;
      if (st === 'mastered') m++; else if (st === 'shaky') s++; else if (st === 'weak') w++;
    });
    var total = m + s + w;
    return total ? Math.round(m * 100 / total) : null;
  }

  function toneOf(rate) {
    if (rate == null) return '';
    if (rate >= 80) return 'tone-ok';
    if (rate >= 50) return '';
    return 'tone-bad';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  /* 总览 KPI 卡 */
  function kpi(label, value, unit, meta, cls, tone) {
    var box = el('div', 'pt-kpi ' + cls);
    var lab = el('span', 'pt-kpi-label');
    lab.appendChild(el('i', 'pt-dot'));
    lab.appendChild(document.createTextNode(label));
    box.appendChild(lab);
    var val = el('strong', 'pt-kpi-value' + (tone ? ' ' + tone : ''));
    val.appendChild(document.createTextNode(String(value)));
    if (unit) val.appendChild(el('small', null, unit));
    box.appendChild(val);
    box.appendChild(el('span', 'pt-kpi-meta', meta));
    return box;
  }

  function renderOverview(kids) {
    var box = document.getElementById('overview');
    if (!box) return;
    var runs = 0, m = 0, s = 0, w = 0, lastAt = '';
    kids.forEach(function (c) {
      var recs = diagRecords(c.id);
      runs += recs.length;
      recs.forEach(function (r) { if (r.savedAt && r.savedAt > lastAt) lastAt = r.savedAt; });
      var by = CC.latestStatus(c.id);
      Object.keys(by).forEach(function (id) {
        var st = by[id].status;
        if (st === 'mastered') m++; else if (st === 'shaky') s++; else if (st === 'weak') w++;
      });
    });
    var tested = m + s + w;
    var rate = tested ? Math.round(m * 100 / tested) : null;
    var maxKids = CC.MAX_CHILDREN || 6;

    box.textContent = '';
    box.appendChild(kpi('在册孩子', kids.length, '个', '最多可建 ' + maxKids + ' 个', 'is-blue', ''));
    box.appendChild(kpi('累计诊断', runs, '次', lastAt ? '最近 ' + fmtDate(lastAt) : '还没有记录', 'is-green', ''));
    box.appendChild(kpi('待补薄弱点', w, '个', tested ? '已测 ' + tested + ' 个知识点' : '还没有测试数据', 'is-red', w ? 'tone-bad' : ''));
    box.appendChild(kpi('平均掌握', rate == null ? '—' : rate, rate == null ? '' : '%',
      tested ? '掌握 ' + m + ' · 不稳 ' + s : '等待第一次诊断', 'is-amber',
      rate == null ? '' : (rate >= 80 ? 'tone-ok' : (rate >= 50 ? '' : 'tone-bad'))));
  }

  /* ---------------------------------------------------------------- 学习进度
   * 用 poptrade 的组件（pt-panel / pt-table / pt-bar / pt-pill / pt-seg）拼一块
   * 「按学科看掌握结构」的表：已测多少、掌握率、掌握/不稳/薄弱的分布条。
   * 数据与档案一致（含手动确认过的点），所以跟诊断页看到的数字对得上。 */
  var SUBJECTS = [['math', '数学'], ['chinese', '语文'], ['english', '英语'], ['physics', '物理']];
  var progressKid = null;

  function subjectStat(childId, subject) {
    var by = CC.latestStatus(childId, subject);
    var m = 0, s = 0, w = 0, manual = 0;
    Object.keys(by).forEach(function (id) {
      var st = by[id].status;
      if (st === 'mastered') m++; else if (st === 'shaky') s++; else if (st === 'weak') w++;
      if (by[id].manual) manual++;
    });
    return { m: m, s: s, w: w, tested: m + s + w, manual: manual };
  }

  function barOf(st) {
    var bar = el('div', 'pt-bar');
    if (!st.tested) { bar.appendChild(el('i', 'u')); return bar; }
    [['m', st.m], ['s', st.s], ['w', st.w]].forEach(function (p) {
      if (!p[1]) return;
      var seg = el('i', p[0]);
      seg.style.width = (p[1] * 100 / st.tested) + '%';
      bar.appendChild(seg);
    });
    return bar;
  }

  function renderProgress(kids) {
    var box = document.getElementById('progress');
    if (!box) return;
    box.textContent = '';
    if (!kids.length) return;

    var cur = kids.filter(function (k) { return k.id === progressKid; })[0] || CC.current() || kids[0];
    progressKid = cur.id;

    var panel = el('section', 'pt-panel pr-panel');
    var head = el('div', 'pt-panel-head');
    var h2 = el('h2');
    var ico = el('span', 'pt-ico');
    ico.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-6M22 19H2"/></svg>';
    h2.appendChild(ico);
    h2.appendChild(document.createTextNode('学习进度'));
    head.appendChild(h2);

    if (kids.length > 1) {
      var seg = el('div', 'pt-seg pr-kids');
      kids.forEach(function (k) {
        var b = el('button', k.id === cur.id ? 'on' : '', k.name);
        b.type = 'button';
        b.addEventListener('click', function () { progressKid = k.id; renderProgress(kids); });
        seg.appendChild(b);
      });
      head.appendChild(seg);
    }
    panel.appendChild(head);

    var body = el('div', 'pt-panel-body');
    var total = { m: 0, s: 0, w: 0, tested: 0, manual: 0 };
    var rows = SUBJECTS.map(function (sj) {
      var st = subjectStat(cur.id, sj[0]);
      total.m += st.m; total.s += st.s; total.w += st.w; total.tested += st.tested; total.manual += st.manual;
      return { name: sj[1], st: st };
    }).filter(function (r) { return r.st.tested > 0; });

    if (!rows.length) {
      var empty = el('div', 'pt-empty');
      empty.appendChild(el('p', null, '「' + cur.name + '」还没有测过的知识点。做一次诊断，或者用「编辑图谱」手动标几个。'));
      body.appendChild(empty);
      panel.appendChild(body);
      box.appendChild(panel);
      return;
    }

    var table = el('table', 'pt-table pr-table');
    var thead = el('thead');
    var htr = el('tr');
    [['学科', ''], ['已测', 'num'], ['掌握率', 'num'], ['掌握 / 不稳 / 薄弱', ''], ['分布', '']].forEach(function (c) {
      var th = el('th', c[1], c[0]);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = el('tbody');
    rows.forEach(function (r) {
      var rate = Math.round(r.st.m * 100 / r.st.tested);
      var tr = el('tr');
      tr.appendChild(el('td', null, r.name));
      tr.appendChild(el('td', 'num', String(r.st.tested)));
      var rateTd = el('td', 'num');
      var pill = el('span', 'pt-pill ' + (rate >= 80 ? 'is-green' : rate >= 50 ? 'is-amber' : 'is-red'), rate + '%');
      rateTd.appendChild(pill);
      tr.appendChild(rateTd);
      var mix = el('td', 'pr-mix');
      mix.appendChild(el('i', 'm', String(r.st.m)));
      mix.appendChild(el('i', 's', String(r.st.s)));
      mix.appendChild(el('i', 'w', String(r.st.w)));
      tr.appendChild(mix);
      var barTd = el('td', 'pr-bar-cell');
      barTd.appendChild(barOf(r.st));
      tr.appendChild(barTd);
      tbody.appendChild(tr);
    });

    /* 合计行 */
    if (rows.length > 1) {
      var trAll = el('tr', 'pr-total');
      trAll.appendChild(el('td', null, '合计'));
      trAll.appendChild(el('td', 'num', String(total.tested)));
      var tRate = Math.round(total.m * 100 / total.tested);
      var tdRate = el('td', 'num');
      tdRate.appendChild(el('span', 'pt-pill ' + (tRate >= 80 ? 'is-green' : tRate >= 50 ? 'is-amber' : 'is-red'), tRate + '%'));
      trAll.appendChild(tdRate);
      var tMix = el('td', 'pr-mix');
      tMix.appendChild(el('i', 'm', String(total.m)));
      tMix.appendChild(el('i', 's', String(total.s)));
      tMix.appendChild(el('i', 'w', String(total.w)));
      trAll.appendChild(tMix);
      var tBar = el('td', 'pr-bar-cell');
      tBar.appendChild(barOf(total));
      trAll.appendChild(tBar);
      tbody.appendChild(trAll);
    }
    table.appendChild(tbody);
    body.appendChild(table);

    var foot = el('p', 'muted small pr-foot');
    foot.textContent = '按知识点算：测过 ' + total.tested + ' 个，掌握 ' + total.m + '、不稳 ' + total.s + '、薄弱 ' + total.w + '。' +
      (total.manual ? '其中 ' + total.manual + ' 个是手动确认的。' : '');
    body.appendChild(foot);
    panel.appendChild(body);
    box.appendChild(panel);
  }


  /* ---------------------------------------------------------------- AI 用量
   * 学生每出一道 AI 题、批一次卷子，都会把这次调用的 token 记下来（assets/usage.js）。
   * 这里只做展示：总数 / 今天 / 近 7 天 / 按孩子拆。数字来自各通道返回的真实 usage，
   * 拿不到用量的调用单独标出来，不拿字数估算冒充真数。 */
  function renderUsage(kids) {
    var box = document.getElementById('usage');
    if (!box) return;
    box.textContent = '';
    var U = window.CnmUsage;
    if (!U) return;

    var s;
    try { s = U.summary(); } catch (e) { return; }
    var panel = el('section', 'pt-panel us-panel');
    var head = el('div', 'pt-panel-head');
    var h2 = el('h2');
    var ico = el('span', 'pt-ico');
    ico.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M7 7.5h6.4a2.6 2.6 0 0 1 0 5.2H8.6a2.6 2.6 0 0 0 0 5.2H16"/></svg>';
    h2.appendChild(ico);
    h2.appendChild(document.createTextNode('AI 用量'));
    head.appendChild(h2);
    var pill = el('span', 'pt-pill is-gray', s.total.calls ? (s.days + ' 天有记录') : '还没有记录');
    head.appendChild(pill);
    panel.appendChild(head);

    var body = el('div', 'pt-panel-body');
    if (!s.total.calls) {
      var empty = el('div', 'pt-empty');
      empty.appendChild(el('p', null, '还没有 AI 调用。用「AI 现出」做题或者让模型批改解答题之后，这里会统计消耗的 token。'));
      body.appendChild(empty);
      panel.appendChild(body);
      box.appendChild(panel);
      return;
    }

    /* 三个数：总计 / 今天 / 近 7 天 */
    var kpis = el('div', 'pt-kpis us-kpis');
    [['总消耗（token）', U.fmt(s.total.t), s.total.calls + ' 次调用'],
     ['今天', U.fmt(s.today.t), s.today.calls ? s.today.calls + ' 次' : '今天还没用'],
     ['近 7 天', U.fmt(s.week.t), s.week.calls + ' 次']].forEach(function (k) {
      var c = el('div', 'pt-kpi us-kpi');
      c.appendChild(el('span', 'pt-kpi-label', k[0]));
      var v = el('strong', 'pt-kpi-value', k[1]);
      c.appendChild(v);
      c.appendChild(el('span', 'pt-kpi-meta', k[2]));
      kpis.appendChild(c);
    });
    body.appendChild(kpis);

    /* 近 7 天小柱状：看得出哪天用得多 */
    var max = 1;
    s.series.forEach(function (d) { if (d.t > max) max = d.t; });
    var chart = el('div', 'us-chart');
    s.series.forEach(function (d) {
      var col = el('div', 'us-col' + (d.t ? '' : ' is-empty'));
      col.title = d.day + '：' + d.calls + ' 次 · ' + d.t + ' token';
      var bar = el('i');
      bar.style.height = Math.max(d.t ? 6 : 2, Math.round(d.t * 100 / max)) + '%';
      col.appendChild(bar);
      col.appendChild(el('span', 'us-col-label', d.label));
      chart.appendChild(col);
    });
    var chartWrap = el('div', 'us-chart-wrap');
    chartWrap.appendChild(el('div', 'us-chart-head', '近 7 天'));
    chartWrap.appendChild(chart);
    body.appendChild(chartWrap);

    /* 按孩子拆 */
    var table = el('table', 'pt-table us-table');
    var thead = el('thead');
    var htr = el('tr');
    [['孩子', ''], ['调用', 'num'], ['输入', 'num'], ['输出', 'num'], ['合计 token', 'num']].forEach(function (c) {
      htr.appendChild(el('th', c[1], c[0]));
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el('tbody');
    s.kids.forEach(function (k) {
      var tr = el('tr');
      tr.appendChild(el('td', null, k.name));
      tr.appendChild(el('td', 'num', String(k.all.calls)));
      tr.appendChild(el('td', 'num', U.fmt(k.all.p)));
      tr.appendChild(el('td', 'num', U.fmt(k.all.c)));
      tr.appendChild(el('td', 'num', U.fmt(k.all.t)));
      tbody.appendChild(tr);
    });
    if (s.total.calls > s.kids.reduce(function (n, k) { return n + k.all.calls; }, 0)) {
      trUnattributed(tbody, s, U);
    }
    if (s.kids.length > 1) {
      var trSum = el('tr', 'us-sum');
      trSum.appendChild(el('td', null, '合计'));
      trSum.appendChild(el('td', 'num', String(s.total.calls)));
      trSum.appendChild(el('td', 'num', U.fmt(s.total.p)));
      trSum.appendChild(el('td', 'num', U.fmt(s.total.c)));
      trSum.appendChild(el('td', 'num', U.fmt(s.total.t)));
      tbody.appendChild(trSum);
    }
    table.appendChild(tbody);
    body.appendChild(table);

    /* 按用途 */
    var kinds = Object.keys(s.total.kinds || {});
    if (kinds.length) {
      var chips = el('div', 'us-kinds');
      kinds.forEach(function (k) {
        var v = s.total.kinds[k];
        var chip = el('span', 'us-chip');
        chip.appendChild(el('b', null, k));
        chip.appendChild(document.createTextNode(' ' + v.calls + ' 次 · ' + U.fmt(v.t) + ' token'));
        chips.appendChild(chip);
      });
      body.appendChild(chips);
    }

    var foot = el('p', 'muted small us-foot');
    foot.textContent = '数字来自模型接口返回的 usage（输入 + 输出）。' +
      (s.total.u ? '其中 ' + s.total.u + ' 次没拿到用量（网页版通道常不带），只计了次数。' : '') +
      '云端通道消耗的是 WorkBuddy 额度，官方 API 通道按 token 计费。';
    body.appendChild(foot);
    panel.appendChild(body);
    box.appendChild(panel);
  }

  function trUnattributed(tbody, s, U) {
    var covered = s.kids.reduce(function (n, k) { return n + k.all.calls; }, 0);
    var rest = s.total.calls - covered;
    if (rest <= 0) return;
    var tr = el('tr');
    tr.appendChild(el('td', null, '（没挂在孩子名下）'));
    tr.appendChild(el('td', 'num', String(rest)));
    tr.appendChild(el('td', 'num', '—'));
    tr.appendChild(el('td', 'num', '—'));
    tr.appendChild(el('td', 'num', '—'));
    tbody.appendChild(tr);
  }


  function emptyState() {
    var box = el('div', 'pt-empty');
    var ico = el('div', 'pt-empty-ico');
    ico.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 20v-1.6a4 4 0 0 0-4-4h-5a4 4 0 0 0-4 4V20"/><circle cx="8.5" cy="7" r="3.4"/><path d="M17.2 12.6a3.3 3.3 0 0 0 0-6.2"/><path d="M21.5 20v-1.5a3.7 3.7 0 0 0-2.6-3.5"/></svg>';
    box.appendChild(ico);
    box.appendChild(el('p', null, '还没有孩子。在右边填昵称和年级，添加第一个。'));
    return box;
  }

  function card(c, isCurrent) {
    var st = stats(c);
    var rate = rateOf(c);
    var art = el('article', 'kid-card' + (isCurrent ? ' is-current' : ''));

    /* 整块可点：一份档案 = 一个孩子，点进去看累积状态和时间线 */
    var open = el('a', 'kid-main');
    open.href = 'history.html?child=' + encodeURIComponent(c.id);
    open.setAttribute('aria-label', '打开「' + c.name + '」的档案');
    var ring = el('div', 'pt-ring ' + toneOf(rate));
    ring.style.setProperty('--p', String(rate || 0));
    ring.appendChild(el('span', 'pt-ring-value', rate == null ? '—' : rate + '%'));
    open.appendChild(ring);

    var box = el('div', 'kid-id');
    var head = el('div', 'kid-head');
    head.appendChild(el('h3', null, c.name));
    if (isCurrent) head.appendChild(el('span', 'pt-pill is-solid', '当前'));
    box.appendChild(head);

    var meta = el('p', 'kid-meta');
    meta.appendChild(el('span', 'pt-pill is-gray', CC.gradeText(c)));
    meta.appendChild(el('span', 'pt-pill is-gray', c.textbook));
    box.appendChild(meta);

    /* 掌握分布：掌握 / 不稳 / 薄弱，比一行文字更快看出结构 */
    if (st.tested) {
      var dist = el('div', 'dist');
      [['m', st.m], ['s', st.s], ['w', st.w]].forEach(function (pair) {
        if (!pair[1]) return;
        var seg = el('i', pair[0]);
        seg.style.width = (pair[1] * 100 / st.tested) + '%';
        dist.appendChild(seg);
      });
      box.appendChild(dist);
    }

    box.appendChild(el('p', 'kid-stat', st.runs
      ? '档案里有 ' + st.tested + ' 个知识点 · ' + st.runs + ' 次诊断汇总'
      : '档案是空的，还没有诊断'));
    open.appendChild(box);
    art.appendChild(open);

    var row = el('div', 'kid-actions');
    if (!isCurrent) {
      var use = el('button', 'primary', '设为当前');
      use.type = 'button';
      use.addEventListener('click', function () {
        CC.setCurrent(c.id);
        if (SC) SC.clearAll();
        render();
      });
      row.appendChild(use);
    }
    var hist = el('a', 'btn', '打开档案');
    hist.href = 'history.html?child=' + encodeURIComponent(c.id);
    row.appendChild(hist);
    /* 「编辑」= 改知识图谱上的掌握状态（草稿 + 确认 + 版本链）；
       改昵称年级这种资料，另有「改资料」，别把两件事塞进同一个按钮。 */
    var edit = el('button', 'primary', '编辑图谱');
    edit.type = 'button';
    edit.addEventListener('click', function () { openGraphEditor(c.id); });
    row.appendChild(edit);
    var info = el('button', null, '改资料');
    info.type = 'button';
    info.addEventListener('click', function () { startEdit(c); });
    row.appendChild(info);
    var del = el('button', 'danger', '删除');
    del.type = 'button';
    del.addEventListener('click', function () {
      if (!confirm('删除「' + c.name + '」的档案和全部诊断记录？删除后无法恢复。')) return;
      CC.remove(c.id);
      if (SC) SC.clearAll();
      if (editing === c.id) resetForm();
      render();
    });
    row.appendChild(del);
    art.appendChild(row);
    return art;
  }

  function render() {
    var kids = CC.list();
    var cur = CC.current();
    listBox.textContent = '';
    renderOverview(kids);
    renderProgress(kids);
    renderUsage(kids);
    var countEl = document.getElementById('kid-count');
    if (countEl) countEl.textContent = kids.length + ' 个';
    if (!kids.length) {
      listBox.appendChild(emptyState());
    } else {
      kids.forEach(function (c) { listBox.appendChild(card(c, !!cur && cur.id === c.id)); });
    }
    var full = kids.length >= CC.MAX_CHILDREN && !editing;
    document.getElementById('form-card').hidden = full;
    if (full) {
      var note = el('p', 'muted small', '已经建满 ' + CC.MAX_CHILDREN + ' 个孩子。要添加新的，先删除不用的档案。');
      listBox.appendChild(note);
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = { name: nameIn.value, grade: gradeSel.value, term: termSel.value, textbook: bookSel.value };
    var res = editing ? CC.update(editing, f) : CC.add(f);
    if (!res.ok) { showError(res.error); return; }
    /* 档案是「当前学习范围」的事实来源：改了年级/学期，手动指定的范围就作废 */
    if (SC) SC.clearAll();
    if (!editing && window.cnmTrack) window.cnmTrack('child_added');
    resetForm();
    render();
  });
  cancelBtn.addEventListener('click', function () { resetForm(); render(); });

  /* 云端合并更新了本地档案后重排（cloud-sync.js 派发） */
  window.addEventListener('cnm-sync-changed', function () { render(); });
  /* 掌握状态确认保存 / 回滚后重算（graph-edit.js 派发） */
  window.addEventListener('cnm-graph-changed', function () { render(); });
  /* 又调了一次模型：用量面板跟着涨（assets/usage.js 派发） */
  window.addEventListener('cnm-usage-changed', function () { renderUsage(CC.list()); });

  function openGraphEditor(id) {
    if (window.CnmGraphEditor) window.CnmGraphEditor.open(id);
    else startEdit(CC.get(id));   // 老缓存里没有编辑器时，退回改资料，别让按钮点了没反应
  }


  /* ---------------------------------------------------------------- 本机数据备份 */
  /* 档案、记录、范围、DeepSeek 凭据都躺在 localStorage 里，而 localStorage 跟着「网址」走。
     预览面板每次换端口、或者从预览切到正式网址，数据就看不到了——导出一个文件带走。 */
  var BACKUP_KEYS = [
    ['cnmChildren.v1', '孩子档案'],
    ['cnmChildren.records.v1', '诊断记录'],
    ['cnmScope.v1', '考察范围'],
    ['cnmReview.chan.v1', 'DeepSeek 网页版凭据'],
    ['cnmDiagnose.ai.v1', '出题方式'],
    ['cnmDiagnose.seen.v1', '出过的题']
  ];

  window.CnmBackup = {
    export: exportBackup,
    import: importBackupData,
    keys: BACKUP_KEYS
  };

  function stamp() {
    var d = new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function exportBackup() {
    var data = {};
    var n = 0;
    BACKUP_KEYS.forEach(function (k) {
      var raw = null;
      try { raw = localStorage.getItem(k[0]); } catch (e) { raw = null; }
      if (raw != null) { data[k[0]] = raw; n++; }
    });
    if (!n) { alert('本机还没有可导出的数据。'); return; }
    var payload = {
      app: 'cnm-knowledge-graph', v: 1, at: new Date().toISOString(),
      note: '含孩子档案、诊断记录、考察范围，以及 DeepSeek 网页版凭据（凭据只在这台设备上用，别外发）',
      data: data
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '知识图谱-备份-' + stamp() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    note('已导出 ' + n + ' 项。换到别的网址后，用「导入备份」把这份文件读回来。');
  }

  /* data: { key: 原始字符串 }；只认白名单里的键，别的忽略 */
  function importBackupData(payload) {
    if (!payload || payload.app !== 'cnm-knowledge-graph' || !payload.data) {
      return { ok: false, error: '这不是本工具导出的备份文件。' };
    }
    var done = 0, skipped = [];
    BACKUP_KEYS.forEach(function (k) {
      var raw = payload.data[k[0]];
      if (raw == null) return;
      try {
        JSON.parse(raw);              // 先确认是合法 JSON，别把坏数据写进去
        localStorage.setItem(k[0], raw);
        done++;
      } catch (e) { skipped.push(k[1]); }
    });
    if (!done) return { ok: false, error: '文件里没有能导入的数据。' };
    return { ok: true, done: done, skipped: skipped };
  }

  function note(msg, isErr) {
    var n = document.getElementById('bk-note');
    if (!n) return;
    n.textContent = msg;
    n.className = 'muted small' + (isErr ? ' err' : '');
  }

  function mountBackup() {
    var aside = document.querySelector('.pt-side');
    if (!aside || document.getElementById('backup-card')) return;
    var card = el('section', 'kid-form');
    card.id = 'backup-card';
    card.appendChild(el('h2', null, '本机数据备份'));
    var p1 = el('p', 'muted small',
      '档案、诊断记录、考察范围和 DeepSeek 凭据都存在浏览器里，而浏览器是按「网址」分开存的：' +
      '换一个网址（预览面板每次端口都不一样）就看不到了。用这里的导出 / 导入把它们带走。');
    card.appendChild(p1);

    var row = el('div', 'form-actions');
    var out = el('button', null, '导出备份');
    out.type = 'button';
    out.addEventListener('click', exportBackup);
    row.appendChild(out);

    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json,.json';
    inp.hidden = true;
    inp.id = 'bk-file';
    var into = el('button', null, '导入备份');
    into.type = 'button';
    into.addEventListener('click', function () { inp.click(); });
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var payload = null;
        try { payload = JSON.parse(String(fr.result)); } catch (e) { payload = null; }
        var r = importBackupData(payload);
        if (!r.ok) { note(r.error, true); return; }
        note('已导入 ' + r.done + ' 项，正在重新加载…');
        setTimeout(function () { location.reload(); }, 400);
      };
      fr.onerror = function () { note('这段文件读不出来。', true); };
      fr.readAsText(f);
      inp.value = '';
    });
    row.appendChild(into);
    row.appendChild(inp);
    card.appendChild(row);

    var hint = el('p', 'muted small',
      '备份文件里有 DeepSeek 网页版凭据（相当于你的登录状态），只自己留着，别发给别人。');
    hint.id = 'bk-note';
    card.appendChild(hint);
    aside.appendChild(card);
  }

  mountBackup();
  resetForm();
  render();
})();
