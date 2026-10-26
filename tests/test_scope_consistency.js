/* 顶栏「考察范围」必须和「本轮」说的是同一件事。
 *
 * 起因（2026-10-27）：孩子档案是五年级上册，但页面顶栏写五年级、本轮却是六年级，
 * 两道信息互相打脸。根因是「按年级开的一轮」在某些入口没有把范围写进 sessionMeta，
 * 顶栏只能退回孩子档案的年级；再加上旧版本留下的存档（label 还是「整体筛查」）没有 scope。
 *
 * 这个测试把三条路径钉住：
 *   A 旧存档（六年级 / 0 题）不该被自动续上，应回到开始页（默认跟孩子档案五年级）
 *   B URL 指定 grade=六年级 → 顶栏六年级 + 本轮六年级
 *   C 单题（六年级知识点）→ 顶栏六年级上册 + 本轮是知识点名
 *
 * 跑法：node tests/test_scope_consistency.js
 * 依赖 jsdom（只在开发机上有；没有就跳过，不算失败）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

let JSDOM;
try { JSDOM = require('jsdom').JSDOM; } catch (e) {
  console.log('跳过：没装 jsdom（npm i -D jsdom 后可跑这个检查）');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'diagnose', 'index.html');
const ORDER = [
  'assets/vendor/cytoscape.min.js', 'assets/vendor/dagre.min.js', 'assets/vendor/cytoscape-dagre.js',
  'diagnose/engine.js', 'assets/children.js', 'assets/scope.js',
  'assets/vendor/qrcode.js', 'diagnose/share.js', 'diagnose/app.js',
  'assets/stats-config.js', 'assets/stats.js', 'assets/shell.js'
];

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '   ' + extra : '')); }
}

/* 页面按 /diagnose/ 取相对路径；这里直接读磁盘，不需要起服务 */
function stubFetch(win) {
  return function (input) {
    let u = String(input && input.url ? input.url : input);
    if (/^https?:/.test(u)) u = new URL(u).pathname;
    const p = path.resolve(ROOT, 'diagnose', decodeURIComponent(u.split('?')[0]));
    if (!fs.existsSync(p)) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404 ' + u)), text: () => Promise.resolve('') });
    }
    const raw = fs.readFileSync(p, 'utf8');
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(raw)), text: () => Promise.resolve(raw) });
  };
}

async function mount(url, seed) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost' + url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = stubFetch(w);
  w.matchMedia = w.matchMedia || function () { return { matches: false, addEventListener() {}, addListener() {} }; };
  w.scrollTo = function () {};
  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  seed(w);
  for (const rel of ORDER) w.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  await new Promise(r => setTimeout(r, 1500));
  return dom;
}

function info(d) {
  const gs = d.querySelector('#scope-grade');
  const ts = d.querySelector('#scope-term');
  const text = d.body.textContent.replace(/\s+/g, ' ');
  const m = text.match(/本轮：\s*([^已结]{1,30}?)\s*(?:已测|$)/);
  return {
    grade: gs ? gs.options[gs.selectedIndex].textContent.trim() : '',
    term: ts ? ts.options[ts.selectedIndex].textContent.trim() : '',
    round: m ? m[1].trim() : '',
    onChip: (function () {
      const c = d.querySelector('.chip.on, .dx-chip.on');
      return c ? c.textContent.trim() : '';
    })(),
    body: text
  };
}

function sixGradeTargets() {
  const ts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'topics.json'), 'utf8'));
  return ts.filter(function (t) {
    return t.grade === 6 && (!t.subject || t.subject === 'math') && !t.external;
  }).map(function (t) { return t.id; });
}

const CHILD = {
  v: 1, current: 'c1',
  children: [{ id: 'c1', name: '张瑞涵', grade: '五年级', term: '上', textbook: '人教版', createdAt: '2026-10-01T00:00:00.000Z' }]
};

(async function () {
  const ids = sixGradeTargets();
  const stale = {
    v: 3, mode: 'screen', targets: ids, base: [], finished: false, open: true, limit: 0,
    label: '六年级（整体筛查）', answers: [], seed: 's1', avoid: [], savedAt: '2026-10-26T10:00:00.000Z'
  };

  console.log('\nA 旧存档（六年级 / 0 题）+ ?mode=grade');
  {
    const dom = await mount('/diagnose/?mode=grade', function (w) {
      w.localStorage.setItem('cnmChildren.v1', JSON.stringify(CHILD));
      w.localStorage.setItem('cnmDiagnose.session.v2', JSON.stringify(stale));
    });
    const i = info(dom.window.document);
    ok('不自动续上旧的一轮（没有顶栏范围控件，说明回到开始页）', !i.grade, JSON.stringify(i).slice(0, 80));
    ok('开始页默认落在孩子档案的年级：五年级', i.onChip === '五年级', '实际 ' + i.onChip);
    dom.window.close();
  }

  console.log('\nB URL 指定 grade=六年级');
  {
    const dom = await mount('/diagnose/?grade=%E5%85%AD%E5%B9%B4%E7%BA%A7&mode=grade', function (w) {
      w.localStorage.setItem('cnmChildren.v1', JSON.stringify(CHILD));
    });
    const i = info(dom.window.document);
    ok('顶栏范围 = 六年级', i.grade === '六年级', '实际 ' + i.grade);
    ok('本轮标签也是六年级（两边一致）', /六年级/.test(i.round), '实际 ' + i.round);
    ok('顶栏给出「回到档案（五年级上册）」', /回到档案（五年级上册）/.test(i.body));
    dom.window.close();
  }

  console.log('\nC 单题：六年级上册的一个知识点');
  {
    const dom = await mount('/diagnose/?target=cnm_p136', function (w) {
      w.localStorage.setItem('cnmChildren.v1', JSON.stringify(CHILD));
    });
    const i = info(dom.window.document);
    ok('顶栏范围按这道题反推 = 六年级 + 上册', i.grade === '六年级' && i.term === '上册', i.grade + '/' + i.term);
    ok('本轮是知识点名（不含年级，不打架）', !!i.round && !/年级/.test(i.round), '实际 ' + i.round);
    dom.window.close();
  }

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
