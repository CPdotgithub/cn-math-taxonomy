/* 孩子档案页：添加、编辑、删除孩子，切换当前孩子。数据来自 assets/children.js（localStorage）。 */
(function () {
  'use strict';
  var CC = window.CnmChildren;
  var listBox = document.getElementById('list');
  var form = document.getElementById('form');
  var nameIn = document.getElementById('f-name');
  var gradeSel = document.getElementById('f-grade');
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
  fillSelect(gradeSel, CC.GRADES, '请选择年级');
  fillSelect(bookSel, CC.TEXTBOOKS);

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
    bookSel.value = CC.TEXTBOOKS[0];
    formTitle.textContent = '添加孩子';
    submitBtn.textContent = '添加孩子';
    cancelBtn.hidden = true;
    showError('');
  }

  function startEdit(c) {
    editing = c.id;
    nameIn.value = c.name;
    gradeSel.value = c.grade;
    bookSel.value = c.textbook;
    formTitle.textContent = '修改「' + c.name + '」的信息';
    submitBtn.textContent = '保存修改';
    cancelBtn.hidden = false;
    showError('');
    document.getElementById('form-card').scrollIntoView({ block: 'center' });
    nameIn.focus();
  }

  function stats(c) {
    var recs = CC.recordsOf(c.id);
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
      var recs = CC.recordsOf(c.id);
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
    meta.appendChild(el('span', 'pt-pill is-gray', c.grade));
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
      use.addEventListener('click', function () { CC.setCurrent(c.id); render(); });
      row.appendChild(use);
    }
    var hist = el('a', 'btn', '打开档案');
    hist.href = 'history.html?child=' + encodeURIComponent(c.id);
    row.appendChild(hist);
    var edit = el('button', null, '编辑');
    edit.type = 'button';
    edit.addEventListener('click', function () { startEdit(c); });
    row.appendChild(edit);
    var del = el('button', 'danger', '删除');
    del.type = 'button';
    del.addEventListener('click', function () {
      if (!confirm('删除「' + c.name + '」的档案和全部诊断记录？删除后无法恢复。')) return;
      CC.remove(c.id);
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
    var f = { name: nameIn.value, grade: gradeSel.value, textbook: bookSel.value };
    var res = editing ? CC.update(editing, f) : CC.add(f);
    if (!res.ok) { showError(res.error); return; }
    if (!editing && window.cnmTrack) window.cnmTrack('child_added');
    resetForm();
    render();
  });
  cancelBtn.addEventListener('click', function () { resetForm(); render(); });

  /* 云端合并更新了本地档案后重排（cloud-sync.js 派发） */
  window.addEventListener('cnm-sync-changed', function () { render(); });

  resetForm();
  render();
})();
