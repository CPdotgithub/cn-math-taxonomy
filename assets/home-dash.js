/* ============================================================================
   首页右栏：当前孩子的掌握情况 + 最近诊断
   ----------------------------------------------------------------------------
   数据全部来自本机 localStorage（window.CnmChildren），未登录时也不上传。
   ============================================================================ */
(function () {
  'use strict';

  var CC = window.CnmChildren;
  if (!CC) return;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function tally(child) {
    var by = CC.latestStatus(child.id);
    var m = 0, s = 0, w = 0;
    Object.keys(by).forEach(function (id) {
      var st = by[id].status;
      if (st === 'mastered') m++;
      else if (st === 'shaky') s++;
      else if (st === 'weak') w++;
    });
    return { m: m, s: s, w: w, tested: m + s + w };
  }

  function rateOf(t) {
    return t.tested ? Math.round(t.m * 100 / t.tested) : null;
  }

  function toneOf(rate) {
    if (rate == null) return '';
    if (rate >= 80) return 'tone-ok';
    if (rate >= 50) return '';
    return 'tone-bad';
  }

  function distBar(t) {
    var wrap = el('div', 'dist');
    var total = t.tested || 1;
    [['m', t.m], ['s', t.s], ['w', t.w]].forEach(function (pair) {
      if (!pair[1]) return;
      var seg = el('i', pair[0]);
      seg.style.width = (pair[1] * 100 / total) + '%';
      wrap.appendChild(seg);
    });
    if (!t.tested) {
      var empty = el('i', 'u');
      empty.style.width = '100%';
      wrap.appendChild(empty);
    }
    return wrap;
  }

  /* ---------------------------------------------------------------- 当前孩子 */
  function renderKid() {
    var body = document.getElementById('kid-body');
    if (!body) return;
    var kids = CC.list();
    var child = CC.current() || kids[0] || null;

    body.textContent = '';

    if (!child) {
      var empty = el('div', 'pt-empty');
      empty.style.padding = '18px 6px 6px';
      var ico = el('div', 'pt-empty-ico');
      ico.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 20v-1.6a4 4 0 0 0-4-4h-5a4 4 0 0 0-4 4V20"/><circle cx="8.5" cy="7" r="3.4"/><path d="M21 20v-1.4a3.6 3.6 0 0 0-2.6-3.4M18 4.2a3.4 3.4 0 0 1 0 6.4"/></svg>';
      empty.appendChild(ico);
      empty.appendChild(el('p', null, '还没有建档案。建一份之后，每次诊断结果会按孩子分开保存。'));
      body.appendChild(empty);
      var cta = el('div', 'kid-empty-cta');
      var addBtn = el('a', 'btn btn-primary', '添加第一个孩子');
      addBtn.href = 'children/';
      cta.appendChild(addBtn);
      body.appendChild(cta);
      return;
    }

    var t = tally(child);
    var rate = rateOf(t);

    var row = el('div', 'kid-current');
    var ring = el('div', 'pt-ring is-lg ' + toneOf(rate));
    ring.style.setProperty('--p', String(rate || 0));
    ring.appendChild(el('span', 'pt-ring-value', rate == null ? '—' : rate + '%'));
    row.appendChild(ring);

    var info = el('div', 'kid-id');
    var head = el('h3', null, child.name);
    if (kids.length > 1) head.appendChild(el('span', 'pt-pill is-solid', '当前'));
    info.appendChild(head);
    info.appendChild(el('p', 'kid-sub', [child.grade, child.textbook].filter(Boolean).join(' · ')));
    row.appendChild(info);
    body.appendChild(row);

    body.appendChild(distBar(t));

    var stats = el('p', 'kid-stats');
    [['m', '掌握', t.m], ['s', '不稳', t.s], ['w', '薄弱', t.w]].forEach(function (x) {
      var s = el('span', x[0]);
      s.appendChild(el('i'));
      s.appendChild(document.createTextNode(x[1] + ' ' + x[2]));
      stats.appendChild(s);
    });
    body.appendChild(stats);

    var actions = el('div', 'kid-panel-actions');
    var go = el('a', 'btn btn-primary', rate == null ? '做第一次诊断' : '继续诊断');
    go.href = 'diagnose/';
    actions.appendChild(go);
    var more = el('a', 'btn', kids.length > 1 ? '切换孩子' : '编辑档案');
    more.href = 'children/';
    actions.appendChild(more);
    body.appendChild(actions);
  }

  /* ---------------------------------------------------------------- 最近诊断 */
  function renderRecent() {
    var body = document.getElementById('recent-body');
    if (!body) return;
    var child = CC.current() || CC.list()[0] || null;
    var recs = child ? CC.recordsOf(child.id).slice(-3).reverse() : [];

    body.textContent = '';

    if (!recs.length) {
      var p = el('p', 'muted small', child
        ? '「' + child.name + '」还没有诊断记录。做完一次，最近的几次会出现在这里。'
        : '建好档案并完成一次诊断后，最近的记录会出现在这里。');
      p.style.margin = '0';
      body.appendChild(p);
      return;
    }

    recs.forEach(function (r) {
      var row = el('a', 'recent-row');
      row.href = 'children/history' + (child ? '?child=' + encodeURIComponent(child.id) : '');

      var top = el('div', 'recent-top');
      top.appendChild(el('span', 'recent-label', r.label || '诊断记录'));
      top.appendChild(el('span', 'recent-date', fmtDate(r.savedAt || r.updatedAt)));
      row.appendChild(top);

      var c = r.counts || {};
      var parts = [];
      if (typeof c.mastered === 'number') parts.push('掌握 ' + c.mastered);
      if (typeof c.shaky === 'number' && c.shaky) parts.push('不稳 ' + c.shaky);
      if (typeof c.weak === 'number' && c.weak) parts.push('薄弱 ' + c.weak);
      if (typeof r.asked === 'number') parts.push('共 ' + r.asked + ' 题');
      if (parts.length) {
        var meta = el('p', 'recent-meta');
        meta.textContent = parts.join(' · ');
        row.appendChild(meta);
      }

      body.appendChild(row);
    });
  }

  function boot() {
    try {
      renderKid();
      renderRecent();
    } catch (e) {
      /* 档案数据异常时不影响首页其它内容 */
    }
  }

  boot();
  window.addEventListener('cnm-sync-changed', boot);
  window.addEventListener('storage', function (e) {
    if (!e.key || e.key.indexOf('cnm') === 0) boot();
  });
})();
