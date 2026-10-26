/* 全站共用的「当前学习范围」：学科 + 年级 + 学期（册次）。
 *
 * 一份状态，四处共用：诊断开始页、复习出题、档案、概览。
 * 取值优先级：手动指定 > 当前孩子的档案 > 各页自己的兜底默认。
 * 档案是孩子就读位置的事实来源；手动指定只在诊断页发生，存下来给复习页接着用，
 * 换了孩子或改了档案年级就作废（clearAll），免得拿着旧年级出题。
 *
 * 年级一律以 engine 的短键存储：'五' / '高一' / '必修一'。
 * 展示时用 fullGrade() 补成「五年级」。
 */
(function () {
  'use strict';
  var KEY = 'cnmScope.v1';
  var SUBJECTS = ['math', 'chinese', 'english', 'physics'];
  var TERM_CN = { '': '', '上': '上册', '下': '下册', '全': '全一册' };

  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY));
      return v && typeof v === 'object' ? v : {};
    } catch (e) { return {}; }
  }
  function write(v) {
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* 隐私模式 */ }
  }

  /* '五年级' → '五'；'高一' / '必修一' / '选必三' 原样 */
  function shortGrade(g) {
    var s = String(g == null ? '' : g).trim();
    var m = /^([一二三四五六七八九])年级$/.exec(s);
    if (m) return m[1];
    return s;
  }
  /* '五' → '五年级'；其余原样 */
  function fullGrade(k) {
    var s = String(k == null ? '' : k).trim();
    return /^[一二三四五六七八九]$/.test(s) ? s + '年级' : s;
  }
  function cleanTerm(t) {
    var s = String(t == null ? '' : t);
    return s === '上' || s === '下' || s === '全' ? s : '';
  }

  function childScope() {
    var C = window.CnmChildren;
    var c = C && C.current ? C.current() : null;
    if (!c) return null;
    var g = shortGrade(c.grade);
    if (!g) return null;
    return { grade: g, term: cleanTerm(c.term), child: c };
  }

  function get(subject) {
    var sub = SUBJECTS.indexOf(subject) >= 0 ? subject : 'math';
    var st = read();
    var mine = st.by && st.by[sub];
    if (mine && mine.grade) return { grade: String(mine.grade), term: cleanTerm(mine.term), manual: true };
    var from = childScope();
    if (from) return { grade: from.grade, term: from.term, manual: false, child: from.child };
    return null;
  }

  function text(scope) {
    if (!scope || !scope.grade) return '';
    return fullGrade(scope.grade) + (TERM_CN[cleanTerm(scope.term)] || '');
  }

  function set(subject, scope) {
    var sub = SUBJECTS.indexOf(subject) >= 0 ? subject : 'math';
    var g = shortGrade(scope && scope.grade);
    if (!g) return;
    var st = read();
    st.v = 1;
    st.by = st.by && typeof st.by === 'object' ? st.by : {};
    st.by[sub] = { grade: g, term: cleanTerm(scope && scope.term) };
    write(st);
  }
  function clear(subject) {
    var st = read();
    if (!st.by) return;
    delete st.by[subject];
    write(st);
  }
  function clearAll() {
    var st = read();
    st.by = {};
    write(st);
  }

  function subject() {
    var s = read().subject;
    return SUBJECTS.indexOf(s) >= 0 ? s : '';
  }
  function setSubject(s) {
    if (SUBJECTS.indexOf(s) < 0) return;
    var st = read();
    st.v = 1;
    st.subject = s;
    write(st);
  }

  window.CnmScope = {
    SUBJECTS: SUBJECTS, TERM_CN: TERM_CN,
    shortGrade: shortGrade, fullGrade: fullGrade,
    childScope: childScope, get: get, text: text,
    set: set, clear: clear, clearAll: clearAll,
    subject: subject, setSubject: setSubject
  };
})();
