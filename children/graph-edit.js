/* 掌握状态编辑器
 * ----------------------------------------------------------------------------
 * 「编辑」改的是知识图谱上的掌握状态：这个知识点算已掌握 / 不稳 / 薄弱，或者撤掉手动判断回到诊断结果。
 *
 * 两条硬规则：
 *   1. 所有改动先放草稿，必须点「确认保存」才写入档案 —— 点叉、按 Esc、切页签都不会偷偷落盘；
 *   2. 每次确认生成一个版本，版本链只追加不覆盖，可以回滚到任意历史版本（回滚也算一个新版本）。
 *
 * 数据在 assets/children.js：CnmChildren.graphOf / commitEdits / revertTo
 * -------------------------------------------------------------------------- */
(function () {
  'use strict';
  var CC = window.CnmChildren;
  if (!CC) return;

  var SUBJECTS = [['math', '数学'], ['chinese', '语文'], ['english', '英语'], ['physics', '物理']];
  var SUBJECT_NAME = { math: '数学', chinese: '语文', english: '英语', physics: '物理' };
  var STATUS = { mastered: ['已掌握', 'ok'], shaky: ['不稳', 'warn'], weak: ['薄弱', 'bad'] };
  var FILTERS = [['', '全部'], ['weak', '薄弱'], ['shaky', '不稳'], ['mastered', '已掌握'], ['manual', '手动改过']];
  var WEIGHT = { weak: 0, shaky: 1, mastered: 2, '': 3 };

  var topicsById = {};       // id -> topic
  var topicsReady = null;
  var mask = null;
  var st = null;             // { childId, child, draft, filter, q, tab }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmt(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var p = function (n) { return ('0' + n).slice(-2); };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function subjectOf(id) { return CC.subjectOf ? CC.subjectOf(id) : 'math'; }
  function nameOf(id) {
    if (topicsById[id] && topicsById[id].name) return topicsById[id].name;
    if (st && st.draft[id] && st.draft[id].name) return st.draft[id].name;
    return id;
  }
  function authorName() {
    var s = window.CnmSync && window.CnmSync.snapshot ? window.CnmSync.snapshot() : null;
    return (s && s.user && s.user.name) ? s.user.name : '本机';
  }

  function loadTopics() {
    if (topicsReady) return topicsReady;
    topicsReady = fetch('../data/topics.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (rows) {
      rows.forEach(function (t) { topicsById[t.id] = t; });
    }).catch(function () { /* 名字拿不到就退回 id，不挡编辑 */ });
    return topicsReady;
  }

  /* ---------------------------------------------------------------- 草稿 */

  function baseOf(id) {
    var by = CC.latestStatus(st.childId);
    var cur = by[id];
    return cur ? { status: cur.status || '', manual: !!cur.manual } : { status: '', manual: false };
  }
  /* 这一行现在显示什么状态：草稿优先 */
  function shownOf(id) {
    if (st.draft[id]) return st.draft[id].to;
    return baseOf(id).status;
  }
  function draftCount() { return Object.keys(st.draft).length; }

  function setStatus(id, to) {
    var base = baseOf(id);
    if (base.status === to) { delete st.draft[id]; return; }
    st.draft[id] = { id: id, name: nameOf(id), from: base.status, to: to };
  }

  /* ---------------------------------------------------------------- 渲染 */

  function open(childId) {
    var child = CC.get(childId);
    if (!child) return;
    st = { childId: childId, child: child, draft: {}, filter: '', q: '', tab: 'graph' };
    build();
    loadTopics().then(function () {
      if (!mask) return;
      paintList();
      paintVersions(mask);   // 版本里记的 id 要靠 topics 翻成名字，加载完再重画一次
    });
  }

  function close(force) {
    if (!force && draftCount() && !confirm('还有 ' + draftCount() + ' 处改动没有确认，关闭就丢掉了。确定关闭？')) return;
    if (!mask) return;
    mask.remove();
    mask = null;
    st = null;
    document.body.classList.remove('has-ge');
    document.removeEventListener('keydown', esc);
  }
  function esc(e) { if (e.key === 'Escape') close(); }

  function build() {
    if (mask) mask.remove();
    mask = el('div', 'ge-mask');
    var card = el('div', 'ge-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    var head = el('div', 'ge-head');
    var titleBox = el('div', 'ge-titlebox');
    titleBox.appendChild(el('h2', null, '编辑「' + st.child.name + '」的掌握状态'));
    titleBox.appendChild(el('p', 'ge-sub', '改的是知识图谱上这个点算不算掌握。改动先放草稿，确认后才写进档案，并生成一个版本。'));
    head.appendChild(titleBox);
    var x = el('button', 'ge-x', '关闭');
    x.type = 'button';
    x.addEventListener('click', function () { close(); });
    head.appendChild(x);
    card.appendChild(head);

    var tabs = el('div', 'ge-tabs');
    [['graph', '掌握状态'], ['versions', '版本链']].forEach(function (t) {
      var b = el('button', 'ge-tab' + (st.tab === t[0] ? ' on' : ''), t[1]);
      b.type = 'button';
      b.dataset.tab = t[0];
      b.addEventListener('click', function () {
        st.tab = t[0];
        Array.prototype.forEach.call(tabs.children, function (c) {
          c.classList.toggle('on', c.dataset.tab === st.tab);
        });
        card.querySelector('[data-pane="graph"]').hidden = st.tab !== 'graph';
        card.querySelector('[data-pane="versions"]').hidden = st.tab !== 'versions';
        if (st.tab === 'versions') paintVersions(card);
      });
      tabs.appendChild(b);
    });
    card.appendChild(tabs);

    var body = el('div', 'ge-body');

    var graph = el('section', 'ge-pane');
    graph.dataset.pane = 'graph';
    var bar = el('div', 'ge-bar');
    var search = el('input', 'ge-search');
    search.type = 'search';
    search.placeholder = '搜知识点，加一个没测过的点（例如：分数乘整数）';
    search.addEventListener('input', function () { st.q = search.value.trim(); paintList(); });
    bar.appendChild(search);
    var seg = el('div', 'pt-seg ge-seg');
    FILTERS.forEach(function (f) {
      var b = el('button', f[0] === st.filter ? 'on' : '', f[1]);
      b.type = 'button';
      b.dataset.filter = f[0];
      b.addEventListener('click', function () {
        st.filter = f[0];
        Array.prototype.forEach.call(seg.children, function (c) { c.classList.toggle('on', c.dataset.filter === st.filter); });
        paintList();
      });
      seg.appendChild(b);
    });
    bar.appendChild(seg);
    graph.appendChild(bar);
    graph.appendChild(el('p', 'ge-hint', '没测过的点也能手动标成「已掌握」——比如孩子在校外已经学过。'));
    var list = el('div', 'ge-list');
    graph.appendChild(list);
    body.appendChild(graph);

    var vers = el('section', 'ge-pane');
    vers.dataset.pane = 'versions';
    vers.hidden = true;
    vers.appendChild(el('p', 'ge-hint', '每次确认保存就是一个版本。回滚不会删历史，它本身也会留下一个版本。'));
    vers.appendChild(el('div', 'ge-vers'));
    body.appendChild(vers);

    card.appendChild(body);

    var foot = el('div', 'ge-foot');
    var cnt = el('span', 'ge-draft');
    foot.appendChild(cnt);
    var cancel = el('button', 'btn', '放弃改动');
    cancel.type = 'button';
    cancel.addEventListener('click', function () {
      if (!draftCount()) { close(true); return; }
      if (!confirm('放弃这 ' + draftCount() + ' 处改动？')) return;
      st.draft = {};
      paintList();
    });
    foot.appendChild(cancel);
    var save = el('button', 'btn btn-primary ge-save', '确认保存');
    save.type = 'button';
    save.addEventListener('click', doSave);
    foot.appendChild(save);
    card.appendChild(foot);

    mask.appendChild(card);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    document.addEventListener('keydown', esc);
    document.body.classList.add('has-ge');
    document.body.appendChild(mask);

    paintFoot();
    paintList();
    paintVersions(card);
  }

  function paintFoot() {
    if (!mask) return;
    var n = draftCount();
    var cnt = mask.querySelector('.ge-draft');
    var save = mask.querySelector('.ge-save');
    cnt.textContent = n ? n + ' 处改动待确认' : '还没有改动';
    cnt.className = 'ge-draft' + (n ? ' is-dirty' : '');
    save.disabled = !n;
  }

  function visibleRows() {
    var by = CC.latestStatus(st.childId);
    var ids = Object.keys(by);
    var seen = {};
    ids.forEach(function (id) { seen[id] = 1; });

    /* 草稿里新增的点也要出现在列表里 */
    Object.keys(st.draft).forEach(function (id) {
      if (!seen[id]) { ids.push(id); seen[id] = 1; }
    });

    var q = st.q.toLowerCase();
    if (q) {
      Object.keys(topicsById).forEach(function (id) {
        if (seen[id]) return;
        var t = topicsById[id];
        if (!t || !t.name) return;
        if (String(t.name).toLowerCase().indexOf(q) < 0) return;
        ids.push(id);
        seen[id] = 1;
      });
    }

    var rows = ids.map(function (id) {
      var shown = shownOf(id);
      return {
        id: id,
        name: nameOf(id),
        status: shown,
        manual: st.draft[id] ? true : baseOf(id).manual,
        drafted: !!st.draft[id],
        subject: subjectOf(id)
      };
    });

    if (q) rows = rows.filter(function (r) { return r.name.toLowerCase().indexOf(q) >= 0 || r.drafted; });
    if (st.filter === 'manual') rows = rows.filter(function (r) { return r.manual; });
    else if (st.filter) rows = rows.filter(function (r) { return r.status === st.filter; });

    rows.sort(function (a, b) {
      var wa = WEIGHT[a.status], wb = WEIGHT[b.status];
      if (wa !== wb) return wa - wb;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });
    return rows;
  }

  function paintList() {
    if (!mask) return;
    var list = mask.querySelector('.ge-list');
    if (!list) return;
    list.textContent = '';
    var rows = visibleRows();

    if (!rows.length) {
      var empty = el('div', 'pt-empty');
      empty.appendChild(el('p', null, st.q
        ? '没找到匹配的知识点，换个词试试。'
        : '这份档案还没有测过的点。用上面的搜索框找知识点，手动标几个。'));
      list.appendChild(empty);
      paintFoot();
      return;
    }

    var groups = {};
    rows.forEach(function (r) { (groups[r.subject] = groups[r.subject] || []).push(r); });
    SUBJECTS.forEach(function (sj) {
      var arr = groups[sj[0]];
      if (!arr || !arr.length) return;
      var g = el('div', 'ge-group');
      var gh = el('div', 'ge-group-head');
      gh.appendChild(el('span', 'ge-group-name', sj[1]));
      gh.appendChild(el('span', 'ge-group-count', arr.length + ' 个'));
      g.appendChild(gh);
      arr.forEach(function (r) { g.appendChild(rowEl(r)); });
      list.appendChild(g);
    });
    paintFoot();
  }

  function rowEl(r) {
    var row = el('div', 'ge-row' + (r.drafted ? ' is-draft' : ''));
    var main = el('div', 'ge-row-main');
    main.appendChild(el('span', 'ge-row-name', r.name));
    if (r.manual) {
      var tag = el('span', 'pt-pill is-amber', '手动');
      tag.title = '这个状态是手动确认过的，不是诊断得出的';
      main.appendChild(tag);
    }
    if (r.drafted) main.appendChild(el('span', 'pt-pill is-solid', '待确认'));
    row.appendChild(main);

    var acts = el('div', 'ge-acts');
    ['mastered', 'shaky', 'weak'].forEach(function (k) {
      var on = r.status === k;
      var b = el('button', 'ge-act is-' + k + (on ? ' on' : ''), STATUS[k][0]);
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () { setStatus(r.id, k); paintList(); });
      acts.appendChild(b);
    });
    if (r.status || r.manual) {
      var clr = el('button', 'ge-act is-clear', '撤');
      clr.type = 'button';
      clr.title = '撤掉手动状态，回到诊断结果';
      clr.disabled = !r.manual && !r.drafted;
      clr.addEventListener('click', function () { setStatus(r.id, ''); paintList(); });
      acts.appendChild(clr);
    }
    row.appendChild(acts);
    return row;
  }

  function paintVersions(card) {
    var box = card.querySelector('.ge-vers');
    if (!box) return;
    box.textContent = '';
    var g = CC.graphOf(st.childId);
    if (!g.revisions.length) {
      var e = el('div', 'pt-empty');
      e.appendChild(el('p', null, '还没有版本。第一次点「确认保存」会生成版本 1。'));
      box.appendChild(e);
      return;
    }
    g.revisions.forEach(function (rev, i) {
      var item = el('div', 'ge-ver');
      var h = el('div', 'ge-ver-head');
      h.appendChild(el('b', null, '版本 ' + (g.revisions.length - i)));
      h.appendChild(el('span', 'ge-ver-time', fmt(rev.at)));
      h.appendChild(el('span', 'pt-pill is-gray', rev.by || '本机'));
      h.appendChild(el('span', 'ge-ver-count', (rev.changes || []).length + ' 处改动'));
      item.appendChild(h);
      if (rev.note) item.appendChild(el('p', 'ge-ver-note', rev.note));
      if ((rev.changes || []).length) {
        var ul = el('ul', 'ge-ver-list');
        rev.changes.slice(0, 6).forEach(function (c) {
          var from = STATUS[c.from] ? STATUS[c.from][0] : '未测';
          var to = STATUS[c.to] ? STATUS[c.to][0] : '撤掉';
          ul.appendChild(el('li', null, (c.name || nameOf(c.id)) + '：' + from + ' → ' + to));
        });
        if (rev.changes.length > 6) ul.appendChild(el('li', 'ge-ver-more', '还有 ' + (rev.changes.length - 6) + ' 处…'));
        item.appendChild(ul);
      }
      var rb = el('button', 'ge-ver-btn', '回滚到这个版本');
      rb.type = 'button';
      rb.addEventListener('click', function () {
        if (!confirm('回滚到「' + fmt(rev.at) + '」这个版本？\n会按这个版本的状态覆盖当前掌握状态，并记录为一个新版本。')) return;
        var r = CC.revertTo(st.childId, rev.id, authorName());
        if (!r.ok) { alert(r.error); return; }
        afterCommit('已回滚，生成版本 ' + (CC.graphOf(st.childId).revisions.length));
      });
      item.appendChild(rb);
      box.appendChild(item);
    });
  }

  function doSave() {
    var changes = Object.keys(st.draft).map(function (id) { return st.draft[id]; });
    if (!changes.length) return;
    var r = CC.commitEdits(st.childId, changes, { by: authorName() });
    if (!r.ok) { alert(r.error); return; }
    st.draft = {};
    afterCommit('已保存 ' + changes.length + ' 处改动，生成版本 ' + CC.graphOf(st.childId).revisions.length);
  }

  function afterCommit(msg) {
    paintList();
    paintVersions(mask);
    toast(msg);
    /* 档案页 / 诊断页都要重新算一遍 */
    window.dispatchEvent(new CustomEvent('cnm-graph-changed'));
  }

  function toast(msg) {
    var t = el('div', 'ge-toast', msg);
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 16);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300);
    }, 2600);
  }

  window.CnmGraphEditor = { open: open, close: close };
})();
