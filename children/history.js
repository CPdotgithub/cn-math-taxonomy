/* 孩子档案详情页：一份档案 = 一个孩子。
 *
 * 上半是这个孩子累积下来的知识状态（按章节分组；同一个知识点测过多次，以最近一次为准），
 * 下半是他的检测时间线——每次诊断只是档案里的一条流水，不是一份独立档案。
 * 数据来自 assets/children.js（localStorage），知识点名称来自 data/topics.json。
 */
(function () {
  'use strict';
  var CC = window.CnmChildren;
  var head = document.getElementById('head');
  var content = document.getElementById('content');
  var SUBJECTS = [['', '全部'], ['math', '数学'], ['chinese', '语文'], ['english', '英语'], ['physics', '物理']];
  var SUBJECT_NAME = { math: '数学', chinese: '语文', english: '英语', physics: '物理' };
  var STATUS = { mastered: ['已掌握', 'ok'], shaky: ['不稳', 'shaky'], weak: ['薄弱', 'weak'] };
  var FILTERS = [['', '全部'], ['weak', '薄弱'], ['shaky', '不稳'], ['mastered', '已掌握']];
  var topics = null;
  var childId = null;
  var subjectSel = '';
  var statusSel = '';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function subjectOfId(id) {
    id = String(id || '');
    return id.indexOf('cne_') === 0 ? 'english' : id.indexOf('cnp_') === 0 ? 'physics' : id.indexOf('cnc_') === 0 ? 'chinese' : 'math';
  }
  function exploreHref(id) {
    var sub = subjectOfId(id);
    return '../explore/' + (sub === 'math' ? '' : '?subject=' + sub) + '#' + encodeURIComponent(id);
  }
  function pad(n) { return ('0' + n).slice(-2); }
  function fmt(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtDay(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function nameOf(id) { return topics && topics[id] ? topics[id].name : id; }
  function tag(cls, text) { return el('span', 'kid-tag ' + cls, text); }
  function retestHref(ids) { return '../diagnose/?target=' + ids.map(encodeURIComponent).join(','); }

  /* 一份档案的全部知识点状态；subject 为空表示不分学科 */
  function statusOf(child, subject) {
    var by = CC.latestStatus(child.id, subject || null);
    var m = 0, s = 0, w = 0;
    Object.keys(by).forEach(function (id) {
      var st = by[id].status;
      if (st === 'mastered') m++; else if (st === 'shaky') s++; else if (st === 'weak') w++;
    });
    return { by: by, m: m, s: s, w: w, tested: m + s + w };
  }

  /* ------------------------------------------------------------ 档案头 */
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

  /* 诊断记录：手动确认的掌握状态也算一条 record，但它不是一次诊断，时间线和「最近」都要排掉 */
  function diagRecords(childId) {
    return CC.recordsOf(childId).filter(function (r) { return r.key !== 'manual:graph'; });
  }

  function renderHead(child, kids) {
    head.textContent = '';
    var recs = diagRecords(child.id);
    var st = statusOf(child, '');
    var rate = st.tested ? Math.round(st.m * 100 / st.tested) : null;
    var lastAt = recs.length ? recs[0].savedAt : '';

    var back = el('p', 'pf-back');
    var backA = el('a', null, '← 全部孩子');
    backA.href = './';
    back.appendChild(backA);
    head.appendChild(back);

    var row = el('div', 'pf-title-row');
    var ring = el('div', 'pt-ring pf-ring ' + (rate == null ? '' : rate >= 80 ? 'tone-ok' : rate >= 50 ? '' : 'tone-bad'));
    ring.style.setProperty('--p', String(rate || 0));
    ring.appendChild(el('span', 'pt-ring-value', rate == null ? '—' : rate + '%'));
    row.appendChild(ring);

    var title = el('div', 'pf-title');
    var h1 = el('h1');
    h1.appendChild(document.createTextNode(child.name));
    if (kids.length && CC.current() && CC.current().id === child.id) h1.appendChild(el('span', 'pt-pill is-solid', '当前'));
    title.appendChild(h1);
    var sub = [CC.gradeText(child), child.textbook];
    if (child.createdAt) {
      var d = new Date(child.createdAt);
      if (!isNaN(d)) sub.push(d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月建档');
    }
    title.appendChild(el('p', 'pf-sub', sub.join(' · ')));
    row.appendChild(title);

    var acts = el('div', 'pf-acts');
    if (kids.length > 1) {
      var sel = el('select');
      sel.setAttribute('aria-label', '切换孩子');
      kids.forEach(function (c) {
        var o = el('option', null, c.name);
        o.value = c.id;
        sel.appendChild(o);
      });
      sel.value = child.id;
      sel.addEventListener('change', function () {
        childId = sel.value;
        CC.setCurrent(childId);
        history.replaceState(null, '', location.pathname + '?child=' + encodeURIComponent(childId));
        init(true);
      });
      acts.appendChild(sel);
    }
    var go = el('a', 'btn btn-primary', '继续诊断');
    go.href = '../diagnose/';
    acts.appendChild(go);
    var manage = el('a', 'btn', '管理档案');
    manage.href = './';
    acts.appendChild(manage);
    row.appendChild(acts);
    head.appendChild(row);

    var kpis = el('div', 'pt-kpis pf-kpis');
    kpis.appendChild(kpi('累计记录', recs.length, '次', lastAt ? '最近 ' + fmtDay(lastAt) : '还没有记录', 'is-blue', ''));
    kpis.appendChild(kpi('已测知识点', st.tested, '个', st.tested ? '覆盖 ' + chapterCount(st.by) + ' 个章节' : '等待第一次诊断', 'is-green', ''));
    kpis.appendChild(kpi('已掌握', st.m, '个', st.tested ? '占已测 ' + Math.round(st.m * 100 / st.tested) + '%' : '—', 'is-amber', ''));
    kpis.appendChild(kpi('待补薄弱', st.w, '个', st.s ? '另有 ' + st.s + ' 个不稳' : '没有不稳的知识点', 'is-red', st.w ? 'tone-bad' : ''));
    head.appendChild(kpis);
  }

  function chapterCount(by) {
    if (!topics) return 0;
    var seen = {};
    Object.keys(by).forEach(function (id) {
      var t = topics[id];
      if (t && t.chapter) seen[t.chapter] = true;
    });
    return Object.keys(seen).length;
  }

  /* ------------------------------------------------------------ 知识地图 */
  function semRank(s) { return s === '上' ? 0 : s === '下' ? 1 : 2; }

  function groupByChapter(ids, by) {
    var map = {}, groups = [];
    ids.forEach(function (id) {
      var t = topics && topics[id];
      var key = t && t.chapter ? t.chapter : '未归入章节';
      if (!map[key]) {
        map[key] = {
          key: key,
          grade: t ? t.grade : 99,
          sem: t ? t.semester : '',
          items: []
        };
        groups.push(map[key]);
      }
      map[key].items.push(id);
    });
    groups.sort(function (a, b) {
      return (a.grade - b.grade) || (semRank(a.sem) - semRank(b.sem)) || String(a.key).localeCompare(String(b.key), 'zh');
    });
    groups.forEach(function (g) {
      g.items.sort(function (a, b) { return String(a).localeCompare(String(b)); });
      var w = 0, s = 0;
      g.items.forEach(function (id) {
        if (by[id].status === 'weak') w++; else if (by[id].status === 'shaky') s++;
      });
      g.weak = w;
      g.shaky = s;
    });
    return groups;
  }

  function topicRow(id, info) {
    var t = topics && topics[id];
    var li = el('li', 'pf-topic is-' + info.status);
    var dot = el('i', 'pf-dot');
    li.appendChild(dot);

    var main = el('div', 'pf-topic-main');
    var a = el('a', 'pf-topic-name', nameOf(id));
    a.href = exploreHref(id);
    main.appendChild(a);
    var meta = [SUBJECT_NAME[subjectOfId(id)]];
    if (info.root) meta.push('根因');
    meta.push(info.manual ? '手动确认' : fmtDay(info.at) + ' 诊断');
    main.appendChild(el('span', 'pf-topic-meta', meta.join(' · ')));
    li.appendChild(main);

    /* 状态标签可能有多个（已掌握 + 手动），包一层再放进网格，别把「再测」挤到下一行 */
    var tags = el('span', 'pf-tags');
    tags.appendChild(tag(STATUS[info.status][1], STATUS[info.status][0]));
    if (info.manual) tags.appendChild(tag('manual', '手动'));
    li.appendChild(tags);

    var re = el('a', 'pf-retest', '再测');
    re.href = retestHref([id]);
    re.title = '再测一次「' + nameOf(id) + '」';
    li.appendChild(re);
    return li;
  }

  function mapSection(child) {
    var st = statusOf(child, subjectSel);
    var ids = Object.keys(st.by).filter(function (id) { return !statusSel || st.by[id].status === statusSel; });

    var sec = el('section', 'kid-section pf-section');
    var headRow = el('div', 'pf-sec-head');
    var h2 = el('h2', null, '累积掌握');
    headRow.appendChild(h2);
    headRow.appendChild(el('span', 'pf-sec-note', st.tested ? '同一知识点以最近一次诊断为准' : ''));
    sec.appendChild(headRow);

    /* 筛选：学科 + 状态 */
    var bar = el('div', 'pf-filters');
    var subSeg = el('div', 'pf-seg');
    SUBJECTS.forEach(function (s) {
      var b = el('button', 'pf-seg-btn' + (subjectSel === s[0] ? ' on' : ''), s[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', subjectSel === s[0] ? 'true' : 'false');
      b.addEventListener('click', function () { subjectSel = s[0]; render(); });
      subSeg.appendChild(b);
    });
    bar.appendChild(subSeg);

    var stSeg = el('div', 'pf-seg');
    FILTERS.forEach(function (f) {
      var n = f[0] ? Object.keys(st.by).filter(function (id) { return st.by[id].status === f[0]; }).length : st.tested;
      var b = el('button', 'pf-seg-btn' + (statusSel === f[0] ? ' on' : ''), f[1] + ' ' + n);
      b.type = 'button';
      b.setAttribute('aria-pressed', statusSel === f[0] ? 'true' : 'false');
      b.addEventListener('click', function () { statusSel = f[0]; render(); });
      stSeg.appendChild(b);
    });
    bar.appendChild(stSeg);
    sec.appendChild(bar);

    if (!st.tested) {
      sec.appendChild(el('p', 'kid-empty', subjectSel
        ? '这个学科还没有诊断记录。'
        : '还没有诊断记录。做完一次诊断，测过的知识点会按章节汇总在这里。'));
      var go = el('a', 'btn btn-primary', '去做第一次诊断');
      go.href = '../diagnose/' + (subjectSel === 'english' || subjectSel === 'physics' || subjectSel === 'chinese' ? '?subject=' + subjectSel : '');
      sec.appendChild(go);
      return sec;
    }
    if (!ids.length) {
      sec.appendChild(el('p', 'kid-empty', statusSel === 'weak' ? '按最近的诊断结果，没有薄弱的知识点。'
        : statusSel === 'shaky' ? '没有不稳的知识点。' : '这个筛选下没有内容。'));
      return sec;
    }

    var groups = groupByChapter(ids, st.by);
    groups.forEach(function (g) {
      var box = el('div', 'pf-group');
      var gh = el('div', 'pf-group-head');
      gh.appendChild(el('span', 'pf-group-name', g.key));
      gh.appendChild(el('span', 'pf-group-n', g.items.length + ' 个'));
      var pills = el('span', 'pf-group-pills');
      if (g.weak) pills.appendChild(tag('weak', '薄弱 ' + g.weak));
      if (g.shaky) pills.appendChild(tag('shaky', '不稳 ' + g.shaky));
      if (pills.childNodes.length) gh.appendChild(pills);
      box.appendChild(gh);

      var ul = el('ul', 'pf-topics');
      g.items.forEach(function (id) { ul.appendChild(topicRow(id, st.by[id])); });
      box.appendChild(ul);
      sec.appendChild(box);
    });
    return sec;
  }

  /* ------------------------------------------------------------ 检测时间线 */
  function recordRow(child, r) {
    var det = el('details', 'rec pf-rec');
    var sum = el('summary', 'pf-rec-sum');

    sum.appendChild(el('span', 'pf-rec-date', fmtDay(r.savedAt)));

    var main = el('span', 'pf-rec-main');
    var titleRow = el('span', 'pf-rec-title');
    titleRow.appendChild(el('b', null, r.label || '诊断'));
    if (r.partial) titleRow.appendChild(tag('shaky', '未测完'));
    main.appendChild(titleRow);
    main.appendChild(el('em', null, (SUBJECT_NAME[r.subject] || '数学') + ' · ' + (r.asked || 0) + ' 题' + (r.mode === 'screen' ? ' · 年级诊断' : '') + (r.mode === 'review' ? ' · 综合考察' : '')));
    sum.appendChild(main);

    var c = r.counts || {};
    var counts = el('span', 'pf-rec-counts');
    if (r.review && typeof r.review.pct === 'number') {
      counts.appendChild(tag(r.review.pct >= 85 ? 'ok' : r.review.pct >= 60 ? 'shaky' : 'weak',
        '得分 ' + r.review.score + '/' + r.review.full));
    } else if (r.mode !== 'review') {
      if (c.weak) counts.appendChild(tag('weak', '薄弱 ' + c.weak));
      if (c.shaky) counts.appendChild(tag('shaky', '不稳 ' + c.shaky));
      if (c.mastered) counts.appendChild(tag('ok', '掌握 ' + c.mastered));
      if (!c.weak && !c.shaky) counts.appendChild(tag('ok', '全部掌握'));
    }
    sum.appendChild(counts);

    det.appendChild(sum);

    var body = el('div', 'rec-body');
    var rootSet = {};
    (r.roots || []).forEach(function (id) { rootSet[id] = true; });
    var group = function (title, ids, status) {
      if (!ids || !ids.length) return;
      body.appendChild(el('h4', null, title + '（' + ids.length + '）'));
      var ul = el('ul', 'rec-topics');
      ids.forEach(function (id) {
        var li = el('li');
        var a = el('a', null, nameOf(id));
        a.href = exploreHref(id);
        li.appendChild(a);
        if (status === 'weak' && rootSet[id]) li.appendChild(tag('root', '根因'));
        ul.appendChild(li);
      });
      body.appendChild(ul);
    };
    group('薄弱', r.weak, 'weak');
    group('不稳', r.shaky, 'shaky');
    if (r.mode === 'review') {
      var lv = (r.review && r.review.levels) || [];
      if (lv.length) {
        var ul2 = el('ul', 'rec-topics');
        var LEVEL_CN = { low: '基础', mid: '变式', high: '综合' };
        lv.forEach(function (l) {
          var li = el('li');
          li.appendChild(el('span', null, (LEVEL_CN[l.key] || l.key) + ' ' + l.got + '/' + l.full + ' 分'));
          ul2.appendChild(li);
        });
        body.appendChild(el('h4', null, '三档得分'));
        body.appendChild(ul2);
      }
      /* AI 逐题归因出来的错因与卡点 */
      var errs = (r.review && r.review.errs) || [];
      if (errs.length) {
        var ul3 = el('ul', 'rec-topics');
        errs.forEach(function (e) {
          var li = el('li');
          li.appendChild(tag('shaky', e.type || '错因'));
          if (e.point) li.appendChild(el('span', null, ' 卡在 ' + e.point));
          ul3.appendChild(li);
        });
        body.appendChild(el('h4', null, 'AI 判定的错因'));
        body.appendChild(ul3);
      }
    } else if (!(r.weak || []).length && !(r.shaky || []).length) {
      body.appendChild(el('p', 'kid-empty', '这次没有发现薄弱或不稳的知识点。'));
    }

    var actions = el('div', 'rec-actions');
    if (r.targets && r.targets.length) {
      var re = el('a', 'btn', '再测一次');
      re.href = retestHref(r.targets);
      actions.appendChild(re);
    }
    var del = el('button', 'danger', '删除这条记录');
    del.type = 'button';
    del.addEventListener('click', function () {
      if (!confirm('删除 ' + fmt(r.savedAt) + ' 的这条诊断记录？档案里的其他记录不受影响。')) return;
      CC.removeRecord(child.id, r.key);
      init(true);
    });
    actions.appendChild(del);
    body.appendChild(actions);
    det.appendChild(body);
    return det;
  }

  function timelineSection(child) {
    var all = diagRecords(child.id);
    var recs = all.filter(function (r) { return !subjectSel || r.subject === subjectSel; });
    var sec = el('section', 'kid-section pf-section');
    var headRow = el('div', 'pf-sec-head');
    headRow.appendChild(el('h2', null, '检测记录'));
    headRow.appendChild(el('span', 'pf-sec-note', recs.length + ' 次' + (subjectSel ? ' · ' + SUBJECT_NAME[subjectSel] : '')));
    sec.appendChild(headRow);

    if (!recs.length) {
      sec.appendChild(el('p', 'kid-empty', subjectSel ? '这个学科还没有记录。' : '还没有诊断记录。'));
      return sec;
    }
    var list = el('div', 'pf-timeline');
    recs.forEach(function (r) { list.appendChild(recordRow(child, r)); });
    sec.appendChild(list);
    return sec;
  }

  /* ------------------------------------------------------------ 渲染 */
  function renderEmpty() {
    head.textContent = '';
    content.textContent = '';
    var box = el('div', 'pt-empty');
    box.appendChild(el('p', null, '还没有孩子档案。先建一份档案，诊断结果才会按孩子存下来。'));
    var add = el('a', 'btn btn-primary', '去建档案');
    add.href = './';
    box.appendChild(add);
    content.appendChild(box);
  }

  function render() {
    var kids = CC.list();
    if (!kids.length) { renderEmpty(); return; }
    var child = CC.get(childId) || kids[0];
    childId = child.id;
    renderHead(child, kids);
    content.textContent = '';
    content.appendChild(mapSection(child));
    content.appendChild(timelineSection(child));
  }

  function init(keepScroll) {
    var y = window.scrollY;
    render();
    if (keepScroll) window.scrollTo(0, y);
  }

  function boot() {
    var kids = CC.list();
    if (!kids.length) { render(); return; }
    var want = new URLSearchParams(location.search).get('child');
    var cur = CC.current();
    childId = (want && CC.get(want) && want) || (cur && cur.id) || (kids[0] && kids[0].id) || null;
    fetch('../data/topics.json').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (rows) {
      topics = {};
      rows.forEach(function (t) { topics[t.id] = t; });
    }).catch(function () { topics = null; }).then(render);
  }

  /* 云端合并更新了本地档案后重排 */
  window.addEventListener('cnm-sync-changed', function () { render(); });
  boot();
})();
