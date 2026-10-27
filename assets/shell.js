/* ============================================================================
   App Shell —— 运行时补全
   ----------------------------------------------------------------------------
   1. 给侧栏导航补图标（各页共用，避免在 4 个 HTML 里重复维护）
   2. 移动端汉堡按钮 + 遮罩 + 键盘/点击关闭
   不改变任何页面的业务行为。
   ============================================================================ */
(function () {
  'use strict';

  var ICONS = {
    home: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.6" y="2.6" width="6.2" height="6.2" rx="1.4"/><rect x="11.2" y="2.6" width="6.2" height="6.2" rx="1.4"/><rect x="2.6" y="11.2" width="6.2" height="6.2" rx="1.4"/><rect x="11.2" y="11.2" width="6.2" height="6.2" rx="1.4"/></svg>',
    graph: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="3.6" r="2.1"/><circle cx="3.9" cy="14.4" r="2.1"/><circle cx="16.1" cy="14.4" r="2.1"/><path d="M8.6 5.5 5.3 12.5M11.4 5.5l3.3 7M6 14.4h8"/></svg>',
    target: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><circle cx="10" cy="10" r="2.6"/><path d="M10 1.4v3M10 15.6v3M1.4 10h3M15.6 10h3"/></svg>',
    spark: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.4l1.7 4.1 4.1 1.7-4.1 1.7L10 14l-1.7-4.1L4.2 8.2l4.1-1.7z"/><path d="M15.6 13.4l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z"/></svg>',
    user: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 17.4v-1.6a4.2 4.2 0 0 0-4.2-4.2H8.2A4.2 4.2 0 0 0 4 15.8v1.6"/><circle cx="10" cy="5.8" r="3.4"/></svg>',
    info: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.4"/><path d="M10 9.2v4.4"/><circle cx="10" cy="6.6" r=".9" fill="currentColor" stroke="none"/></svg>'
  };

  function iconFor(link) {
    if (link.classList.contains('subject-link') || link.classList.contains('resource-search-btn')) return null;
    var href = link.getAttribute('href') || '';
    if (href.indexOf('github.com') >= 0 || href.indexOf('issues') >= 0) return ICONS.info;
    if (href.indexOf('explore/') >= 0) return ICONS.graph;
    if (href.indexOf('diagnose/') >= 0) return ICONS.target;
    if (href.indexOf('review/') >= 0) return ICONS.spark;
    if (href.indexOf('children/') >= 0) return ICONS.user;
    // 当前页的入口常常写成 './'，按 body[data-page] 补图标，别一律落到首页图标
    if (link.getAttribute('aria-current') === 'page' || link.classList.contains('active')) {
      var page = document.body.getAttribute('data-page') || '';
      if (page === 'explore') return ICONS.graph;
      if (page === 'diagnose') return ICONS.target;
      if (page === 'review') return ICONS.spark;
      if (page === 'kids' || page === 'history' || page === 'children') return ICONS.user;
      return ICONS.home;
    }
    return ICONS.home;
  }

  function dressNav() {
    document.querySelectorAll('.page-links .nav-link').forEach(function (link) {
      if (link.querySelector('svg')) return;
      var markup = iconFor(link);
      if (!markup) return;
      var wrap = document.createElement('span');
      wrap.innerHTML = markup;
      var svg = wrap.firstChild;
      if (svg) link.insertBefore(svg, link.firstChild);
    });
  }

  function mountDrawer() {
    if (document.querySelector('.rail-toggle')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail-toggle';
    btn.setAttribute('aria-label', '打开导航');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'site-rail');
    btn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14"/></svg>';

    var scrim = document.createElement('div');
    scrim.className = 'rail-scrim';
    scrim.hidden = false;

    var header = document.querySelector('.site-header');
    if (header && !header.id) header.id = 'site-rail';

    function setOpen(on) {
      document.body.classList.toggle('rail-open', on);
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      btn.setAttribute('aria-label', on ? '关闭导航' : '打开导航');
      if (on) {
        var first = header && header.querySelector('.nav-link');
        if (first) first.focus({ preventScroll: true });
      }
    }

    btn.addEventListener('click', function () {
      setOpen(!document.body.classList.contains('rail-open'));
    });
    scrim.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('rail-open')) setOpen(false);
    });
    if (header) {
      header.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('click', function () { setOpen(false); });
      });
    }
    // 视口变宽时清掉抽屉状态，避免残留
    window.addEventListener('resize', function () {
      if (window.innerWidth > 900 && document.body.classList.contains('rail-open')) setOpen(false);
    });

    document.body.insertBefore(btn, document.body.firstChild);
    document.body.insertBefore(scrim, document.body.firstChild);
  }

  /* 存不住数据要先说清楚：这个地址的浏览器不给写 localStorage（预览面板的沙箱 iframe 常见），
     档案、凭据、进度全都存不下来，等用户填完才发现就晚了。 */
  function storageBanner() {
    var bad = null;
    try {
      localStorage.setItem('__cnmProbe', '1');
      localStorage.removeItem('__cnmProbe');
    } catch (e) { bad = String(e && e.message || e); }
    if (!bad) return;
    var box = document.createElement('div');
    box.className = 'cnm-storage-warn';
    box.setAttribute('role', 'alert');
    box.innerHTML = '<b>这个地址存不住数据</b>：浏览器不允许写入本地存储，孩子档案、DeepSeek 凭据、诊断进度都保存不下来。' +
      '换成双击「启动.command」打开的那个页面，或者用发布后的网址，就正常了。';
    document.body.insertBefore(box, document.body.firstChild);
  }

  function boot() {
    dressNav();
    if (document.body.classList.contains('has-rail')) mountDrawer();
    storageBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
