#!/usr/bin/env node
/* 掌握状态编辑 + 版本链测试：node tests/test_graph_edit.js（无依赖，仅用 assert）
 * 用一个假 window / localStorage 把 assets/children.js 跑起来。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}

/* ---------- 造一个最小的浏览器环境 ---------- */
function makeStore() {
  const store = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    _dump() { return store; }
  };
}
function loadCC() {
  const ls = makeStore();
  const win = {};
  const ctx = {
    window: win,
    localStorage: ls,
    console,
    Date,
    JSON,
    Math,
    String,
    Object,
    Array,
    isNaN,
    setTimeout,
    clearTimeout
  };
  const code = fs.readFileSync(path.join(__dirname, '..', 'assets', 'children.js'), 'utf8');
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'children.js' });
  return { CC: win.CnmChildren, ls };
}
function addKid(CC, name) {
  const r = CC.add({ name: name || '小满', grade: '五年级', term: '上', textbook: '人教版' });
  assert.ok(r.ok, r.error);
  return r.child.id;
}
function rec(CC, kid, key, at, weak, mastered) {
  CC.saveRecord(kid, {
    key, subject: 'math', label: '诊断', savedAt: at, updatedAt: at,
    weak: weak || [], shaky: [], mastered: mastered || [], roots: []
  });
  /* saveRecord 会用 now 覆盖 savedAt（新记录），这里强制写回指定时间 */
  const all = JSON.parse(ls_raw(CC));
  const arr = all[kid];
  const i = arr.findIndex((x) => x.key === key);
  arr[i].savedAt = at;
  arr[i].updatedAt = at;
  ls_write(CC, all);
}
/* 直接拿 localStorage 对象（children.js 把数据都写在这两个键里） */
let LS = null;
function ls_raw() { return LS.getItem('cnmChildren.records.v1') || '{}'; }
function ls_write(CC, obj) { LS.setItem('cnmChildren.records.v1', JSON.stringify(obj)); }

function boot() {
  const { CC, ls } = loadCC();
  LS = ls;
  const kid = addKid(CC);
  return { CC, kid };
}

/* ------------------------------------------------------------ 用例 */

test('确认一次改动：写入覆盖 + 生成版本', () => {
  const { CC, kid } = boot();
  const r = CC.commitEdits(kid, [{ id: 'cnm_p001', name: '十几减9', from: '', to: 'mastered' }], { by: '老师' });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.rev.changes.length, 1);
  assert.strictEqual(r.rev.by, '老师');
  const by = CC.latestStatus(kid);
  assert.strictEqual(by['cnm_p001'].status, 'mastered');
  assert.strictEqual(by['cnm_p001'].manual, true);
  const g = CC.graphOf(kid);
  assert.strictEqual(g.revisions.length, 1);
});

test('改动和原来一样 → 拒绝保存（不产生空版本）', () => {
  const { CC, kid } = boot();
  CC.commitEdits(kid, [{ id: 'cnm_p002', name: 'X', from: '', to: 'shaky' }], {});
  const r = CC.commitEdits(kid, [{ id: 'cnm_p002', name: 'X', from: 'shaky', to: 'shaky' }], {});
  assert.strictEqual(r.ok, false);
  assert.ok(/没有可保存/.test(r.error));
  assert.strictEqual(CC.graphOf(kid).revisions.length, 1);
});

test('撤掉手动状态 → 回到诊断结果', () => {
  const { CC, kid } = boot();
  rec(CC, kid, 'r1', '2026-10-01T10:00:00.000Z', ['cnm_p003']);
  CC.commitEdits(kid, [{ id: 'cnm_p003', name: 'X', from: 'weak', to: 'mastered' }], {});
  assert.strictEqual(CC.latestStatus(kid)['cnm_p003'].status, 'mastered');
  CC.commitEdits(kid, [{ id: 'cnm_p003', name: 'X', from: 'mastered', to: '' }], {});
  assert.strictEqual(CC.latestStatus(kid)['cnm_p003'].status, 'weak');
  assert.strictEqual(CC.latestStatus(kid)['cnm_p003'].manual, undefined);
});

test('确认之后又做了诊断 → 以更新的诊断为准', () => {
  const { CC, kid } = boot();
  CC.commitEdits(kid, [{ id: 'cnm_p004', name: 'X', from: '', to: 'mastered' }], {});
  const g = CC.graphOf(kid);
  const at = g.overrides['cnm_p004'].at;
  /* 诊断时间晚于手动确认 */
  const later = new Date(Date.parse(at) + 60000).toISOString();
  rec(CC, kid, 'r2', later, ['cnm_p004']);
  assert.strictEqual(CC.latestStatus(kid)['cnm_p004'].status, 'weak');
  assert.strictEqual(CC.latestStatus(kid)['cnm_p004'].manual, undefined);
});

test('诊断早于手动确认 → 手动状态仍然生效', () => {
  const { CC, kid } = boot();
  rec(CC, kid, 'r3', '2026-10-01T10:00:00.000Z', ['cnm_p005']);
  CC.commitEdits(kid, [{ id: 'cnm_p005', name: 'X', from: 'weak', to: 'shaky' }], {});
  assert.strictEqual(CC.latestStatus(kid)['cnm_p005'].status, 'shaky');
  assert.strictEqual(CC.latestStatus(kid)['cnm_p005'].manual, true);
});

test('回滚：恢复目标版本，且回滚本身也记一版', () => {
  const { CC, kid } = boot();
  const r1 = CC.commitEdits(kid, [{ id: 'cnm_p006', name: 'X', from: '', to: 'mastered' }], {});
  CC.commitEdits(kid, [{ id: 'cnm_p006', name: 'X', from: 'mastered', to: 'weak' }], {});
  CC.commitEdits(kid, [{ id: 'cnm_p007', name: 'Y', from: '', to: 'shaky' }], {});
  assert.strictEqual(CC.latestStatus(kid)['cnm_p006'].status, 'weak');
  const rv = CC.revertTo(kid, r1.rev.id, '老师');
  assert.ok(rv.ok, rv.error);
  const by = CC.latestStatus(kid);
  assert.strictEqual(by['cnm_p006'].status, 'mastered');  // 回到第一版
  assert.strictEqual(by['cnm_p007'], undefined);          // 后来加的点被撤回
  assert.strictEqual(CC.graphOf(kid).revisions.length, 4); // 3 次确认 + 1 次回滚
  assert.ok(CC.graphOf(kid).revisions[0].revertOf);
});

test('版本链最多保留 20 版（历史不会被无限增长撑爆）', () => {
  const { CC, kid } = boot();
  for (let i = 0; i < 26; i++) {
    CC.commitEdits(kid, [{ id: 'cnm_p00' + (i % 5), name: 'X', from: i % 2 ? 'weak' : '', to: i % 2 ? '' : 'weak' }], {});
  }
  const g = CC.graphOf(kid);
  assert.ok(g.revisions.length <= 20, 'revisions=' + g.revisions.length);
  assert.ok(g.revisions.length >= 5);
});

test('手动状态不会被 40 条诊断记录挤掉', () => {
  const { CC, kid } = boot();
  CC.commitEdits(kid, [{ id: 'cnm_p008', name: 'X', from: '', to: 'mastered' }], {});
  for (let i = 0; i < 45; i++) {
    rec(CC, kid, 'r' + i, new Date(Date.parse('2026-01-01T00:00:00Z') + i * 3600000).toISOString(), ['cnm_q' + i]);
  }
  const recs = CC.recordsOf(kid);
  assert.ok(recs.length <= 40, 'records=' + recs.length);
  assert.ok(recs.some((r) => r.key === 'manual:graph'), '手动状态记录被挤掉了');
  assert.ok(recs.length >= 1);
});

test('手动状态是档案里的一条记录，会跟着云同步一起走', () => {
  const { CC, kid } = boot();
  CC.commitEdits(kid, [{ id: 'cnm_p009', name: 'X', from: '', to: 'shaky' }], {});
  const r = CC.recordsOf(kid).find((x) => x.key === 'manual:graph');
  assert.ok(r, '没有 manual:graph 记录');
  assert.strictEqual(r.kind, 'manual-graph');
  assert.ok(r.overrides && r.overrides['cnm_p009']);
  assert.ok(Array.isArray(r.revisions) && r.revisions.length === 1);
});

test('latestStatus 按学科过滤时也带上手动状态', () => {
  const { CC, kid } = boot();
  CC.commitEdits(kid, [
    { id: 'cnm_p010', name: '数学点', from: '', to: 'mastered' },
    { id: 'cne_0001', name: '英语点', from: '', to: 'weak' }
  ], {});
  const math = CC.latestStatus(kid, 'math');
  const eng = CC.latestStatus(kid, 'english');
  assert.strictEqual(math['cnm_p010'].status, 'mastered');
  assert.strictEqual(math['cne_0001'], undefined);
  assert.strictEqual(eng['cne_0001'].status, 'weak');
});

console.log('\n' + (failed ? '失败 ' + failed : '全部通过') + '  （' + passed + ' 项）');
process.exit(failed ? 1 : 0);
