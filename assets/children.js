/* 孩子档案：多个孩子、当前孩子、每个孩子的诊断记录。全部保存在本机 localStorage，不上传、不需要账号。
 * 诊断页和档案页共用。window.CnmChildren。 */
(function () {
  'use strict';
  var KEY = 'cnmChildren.v1';
  var REC_KEY = 'cnmChildren.records.v1';
  var MAX_CHILDREN = 8;
  var MAX_RECORDS = 40;
  var GRADES = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级', '七年级', '八年级', '九年级', '高一', '高二', '高三'];
  var TEXTBOOKS = ['人教版', '北师大版', '苏教版', '沪教版', '外研版', '译林版', '其他'];
  /* 学期：'' 整学年（不想分上下的）、'上' 上册、'下' 下册。高中按必修/选必分册，固定 '' */
  var TERMS = [['上', '上学期（上册）'], ['下', '下学期（下册）'], ['', '整学年']];
  var TERM_SHORT = { '上': '上册', '下': '下册', '': '' };
  var SENIOR = ['高一', '高二', '高三'];

  function read(k, fallback) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }

  function state() {
    var s = read(KEY, null);
    if (!s || !Array.isArray(s.children)) s = { v: 1, current: null, children: [] };
    if (s.current && !s.children.some(function (c) { return c.id === s.current; })) s.current = s.children.length ? s.children[0].id : null;
    return s;
  }
  function records() {
    var r = read(REC_KEY, null);
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  }
  function newId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function list() { return state().children.slice(); }
  function get(id) { return state().children.filter(function (c) { return c.id === id; })[0] || null; }
  function current() { var s = state(); return s.current ? get(s.current) : null; }
  function setCurrent(id) {
    var s = state();
    if (id && !s.children.some(function (c) { return c.id === id; })) return false;
    s.current = id || null;
    return write(KEY, s);
  }

  function clean(f) {
    var name = String(f && f.name || '').replace(/\s+/g, ' ').trim();
    var grade = GRADES.indexOf(f && f.grade) >= 0 ? f.grade : '';
    var textbook = TEXTBOOKS.indexOf(f && f.textbook) >= 0 ? f.textbook : TEXTBOOKS[0];
    var term = (f && (f.term === '上' || f.term === '下')) ? f.term : '';
    /* 高中按必修/选必分册，没有上下学期 */
    if (SENIOR.indexOf(grade) >= 0) term = '';
    return { name: name, grade: grade, term: term, textbook: textbook };
  }

  /* 展示用：「五年级」/「五年级上册」 */
  function gradeText(c) {
    if (!c || !c.grade) return '';
    return c.grade + (TERM_SHORT[c.term] || '');
  }
  function check(s, f, selfId) {
    if (!f.name) return '请填写孩子的昵称。';
    if (f.name.length > 12) return '昵称最多 12 个字。';
    if (!f.grade) return '请选择年级。';
    if (s.children.some(function (c) { return c.id !== selfId && c.name === f.name; })) return '已经有叫「' + f.name + '」的孩子了，换个昵称区分。';
    return '';
  }

  /* 返回 { ok, error, child } */
  function add(form) {
    var s = state();
    var f = clean(form);
    if (s.children.length >= MAX_CHILDREN) return { ok: false, error: '最多可以建 ' + MAX_CHILDREN + ' 个孩子。' };
    var err = check(s, f, null);
    if (err) return { ok: false, error: err };
    var child = { id: newId(), name: f.name, grade: f.grade, term: f.term, textbook: f.textbook, createdAt: new Date().toISOString() };
    s.children.push(child);
    if (!s.current) s.current = child.id;
    if (!write(KEY, s)) return { ok: false, error: '浏览器不允许保存数据（可能是隐私模式），档案无法保存。' };
    return { ok: true, child: child };
  }
  function update(id, form) {
    var s = state();
    var f = clean(form);
    var i = s.children.map(function (c) { return c.id; }).indexOf(id);
    if (i < 0) return { ok: false, error: '找不到这个孩子。' };
    var err = check(s, f, id);
    if (err) return { ok: false, error: err };
    s.children[i] = Object.assign({}, s.children[i], f);
    write(KEY, s);
    return { ok: true, child: s.children[i] };
  }
  function remove(id) {
    var s = state();
    s.children = s.children.filter(function (c) { return c.id !== id; });
    if (s.current === id) s.current = s.children.length ? s.children[0].id : null;
    write(KEY, s);
    var r = records();
    delete r[id];
    write(REC_KEY, r);
  }

  function recordsOf(childId) {
    var r = records()[childId];
    return Array.isArray(r) ? r.slice().sort(function (a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); }) : [];
  }
  /* 按 rec.key 覆盖：同一次诊断反复打开结果页、更正答案，只会更新这一条 */
  function saveRecord(childId, rec) {
    if (!childId || !rec || !rec.key) return false;
    var all = records();
    var arr = Array.isArray(all[childId]) ? all[childId] : [];
    var i = arr.map(function (x) { return x.key; }).indexOf(rec.key);
    var now = new Date().toISOString();
    if (i >= 0) arr[i] = Object.assign({}, rec, { savedAt: arr[i].savedAt, updatedAt: now });
    else arr.push(Object.assign({}, rec, { savedAt: now, updatedAt: now }));
    arr.sort(function (a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); });
    var kept = arr.slice(0, MAX_RECORDS);
    /* 手动确认的掌握状态不能被一串诊断记录挤出档案 */
    var g = null;
    for (var k = 0; k < arr.length; k++) if (arr[k].key === GRAPH_REC) { g = arr[k]; break; }
    if (g && kept.indexOf(g) < 0) kept = kept.slice(0, MAX_RECORDS - 1).concat([g]);
    all[childId] = kept;
    return write(REC_KEY, all);
  }
  function hasRecord(childId, key) {
    return recordsOf(childId).some(function (x) { return x.key === key; });
  }
  function moveRecord(key, fromId, toId) {
    if (!key || fromId === toId) return;
    var all = records();
    var from = Array.isArray(all[fromId]) ? all[fromId] : [];
    var rec = from.filter(function (x) { return x.key === key; })[0];
    if (!rec) return;
    all[fromId] = from.filter(function (x) { return x.key !== key; });
    var to = Array.isArray(all[toId]) ? all[toId] : [];
    if (!to.some(function (x) { return x.key === key; })) to.push(rec);
    to.sort(function (a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); });
    all[toId] = to.slice(0, MAX_RECORDS);
    write(REC_KEY, all);
  }
  function removeRecord(childId, key) {
    var all = records();
    if (!Array.isArray(all[childId])) return;
    all[childId] = all[childId].filter(function (x) { return x.key !== key; });
    write(REC_KEY, all);
  }

  /* ---------------------------------------------------------------- 掌握状态的手动确认
   * 家长可以直接改「这个点算掌握 / 不稳 / 薄弱」——但只能在编辑器里改完再显式确认，
   * 保存时生成一个版本，历史只追加不覆盖。
   *
   * 存储：作为一条特殊记录（key = manual:graph）存在 records 里，
   *   这样云同步、导出备份、LWW 合并全都复用现成的管线，不用再开一张表。
   * 生效规则：手动确认的时间 >= 诊断记录的时间才盖过诊断；之后又做了诊断，以诊断为准。
   */
  var GRAPH_REC = 'manual:graph';
  var MAX_REVISIONS = 20;

  function graphRecord(childId) {
    var arr = recordsOf(childId);
    for (var i = 0; i < arr.length; i++) if (arr[i].key === GRAPH_REC) return arr[i];
    return null;
  }
  function graphOf(childId) {
    var r = graphRecord(childId);
    return {
      overrides: (r && r.overrides && typeof r.overrides === 'object') ? r.overrides : {},
      revisions: (r && Array.isArray(r.revisions)) ? r.revisions : []
    };
  }
  function saveGraph(childId, g, at) {
    var stamp = at || new Date().toISOString();
    return saveRecord(childId, {
      key: GRAPH_REC, kind: 'manual-graph', subject: '', label: '掌握状态（手动确认）',
      overrides: g.overrides || {}, revisions: g.revisions || [],
      savedAt: stamp, updatedAt: stamp
    });
  }
  function revId() { return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  /* changes: [{ id, name, from, to }]；to 为空字符串表示「撤掉手动状态，回到诊断结果」 */
  function commitEdits(childId, changes, opts) {
    if (!childId) return { ok: false, error: '找不到这个孩子。' };
    var g = graphOf(childId);
    var at = new Date().toISOString();
    var id = revId();
    var applied = [];
    (changes || []).forEach(function (c) {
      if (!c || !c.id || (c.from || '') === (c.to || '')) return;
      if (c.to) g.overrides[c.id] = { status: c.to, at: at, rev: id };
      else delete g.overrides[c.id];
      applied.push({ id: c.id, name: c.name || '', from: c.from || '', to: c.to || '' });
    });
    if (!applied.length) return { ok: false, error: '改动和现在一样，没有可保存的。' };
    var rev = {
      id: id, at: at, by: (opts && opts.by) || '本机', note: (opts && opts.note) || '',
      changes: applied, snapshot: JSON.parse(JSON.stringify(g.overrides))
    };
    g.revisions.unshift(rev);
    g.revisions = g.revisions.slice(0, MAX_REVISIONS);
    if (!saveGraph(childId, g, at)) return { ok: false, error: '浏览器不允许保存数据，改动没有写入。' };
    return { ok: true, rev: rev };
  }

  /* 回滚本身也是一个新版本：把目标版本的快照写回去，历史不动 */
  function revertTo(childId, targetId, by) {
    var g = graphOf(childId);
    var target = null;
    g.revisions.forEach(function (r) { if (r.id === targetId) target = r; });
    if (!target) return { ok: false, error: '找不到这个版本。' };
    var before = g.overrides || {};
    var after = target.snapshot || {};
    var at = new Date().toISOString();
    var id = revId();
    var seen = {}, changes = [];
    Object.keys(before).forEach(function (k) { seen[k] = 1; });
    Object.keys(after).forEach(function (k) { seen[k] = 1; });
    Object.keys(seen).forEach(function (k) {
      var b = (before[k] && before[k].status) || '';
      var a = (after[k] && after[k].status) || '';
      if (b !== a) changes.push({ id: k, name: '', from: b, to: a });
    });
    var overrides = {};
    Object.keys(after).forEach(function (k) {
      overrides[k] = { status: after[k].status, at: at, rev: id };
    });
    var rev = {
      id: id, at: at, by: by || '本机',
      note: '回滚到 ' + (target.at || '').slice(0, 16).replace('T', ' '),
      changes: changes, snapshot: overrides, revertOf: target.id
    };
    g.overrides = overrides;
    g.revisions.unshift(rev);
    g.revisions = g.revisions.slice(0, MAX_REVISIONS);
    if (!saveGraph(childId, g, at)) return { ok: false, error: '浏览器不允许保存数据，回滚没有写入。' };
    return { ok: true, rev: rev, count: changes.length };
  }

  /* 档案里除了诊断记录，还挂着两类「元记录」：手动确认的掌握状态、AI 用量。
     它们不是一次诊断，凡是要按「诊断次数 / 时间线」统计的地方都得排掉。 */
  function isDiagRecord(r) {
    if (!r) return false;
    if (r.kind === 'manual-graph' || r.kind === 'usage') return false;
    return r.key !== 'manual:graph' && r.key !== 'usage:ai';
  }

  function subjectOf(id) {
    var s = String(id || '');
    if (s.indexOf('cne_') === 0) return 'english';
    if (s.indexOf('cnp_') === 0) return 'physics';
    if (s.indexOf('cnc_') === 0) return 'chinese';
    return 'math';
  }

  /* 把某个孩子的全部记录合成「每个知识点现在的状态」：越新的记录越说了算。
   * 手动确认过的点，只要确认时间不早于诊断时间，就按手动状态算。
   * 返回 { byId: { id: { status, recKey, at, label, root, manual } } } */
  function latestStatus(childId, subject) {
    var recs = recordsOf(childId).filter(function (r) { return !subject || r.subject === subject; }).reverse();
    var by = {};
    recs.forEach(function (r) {
      var roots = {};
      (r.roots || []).forEach(function (id) { roots[id] = true; });
      var put = function (ids, status) {
        (ids || []).forEach(function (id) { by[id] = { status: status, recKey: r.key, at: r.savedAt, label: r.label, root: !!roots[id], subject: r.subject }; });
      };
      put(r.mastered, 'mastered');
      put(r.shaky, 'shaky');
      put(r.weak, 'weak');
    });

    var g = graphOf(childId);
    Object.keys(g.overrides).forEach(function (id) {
      var ov = g.overrides[id];
      if (!ov || !ov.status) return;
      var sub = subjectOf(id);
      if (subject && sub !== subject) return;
      var cur = by[id];
      if (cur && String(cur.at || '') > String(ov.at || '')) return;  // 之后又诊断过，诊断更新
      by[id] = { status: ov.status, recKey: GRAPH_REC, at: ov.at, label: '手动确认', root: false, subject: sub, manual: true };
    });
    return by;
  }

  window.CnmChildren = {
    GRADES: GRADES, TEXTBOOKS: TEXTBOOKS, TERMS: TERMS, MAX_CHILDREN: MAX_CHILDREN,
    list: list, get: get, current: current, setCurrent: setCurrent,
    add: add, update: update, remove: remove, gradeText: gradeText,
    recordsOf: recordsOf, saveRecord: saveRecord, hasRecord: hasRecord, moveRecord: moveRecord, removeRecord: removeRecord,
    latestStatus: latestStatus,
    GRAPH_REC: GRAPH_REC, graphOf: graphOf, commitEdits: commitEdits, revertTo: revertTo, subjectOf: subjectOf,
    isDiagRecord: isDiagRecord
  };
})();
