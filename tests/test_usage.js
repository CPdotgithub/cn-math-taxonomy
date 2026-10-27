#!/usr/bin/env node
/* AI 用量统计测试：node tests/test_usage.js（无依赖）
 * 验证：按天/按孩子归集、没归属的进本机、跨设备合并取最大（幂等）、格式化。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e).split('\n').slice(0, 5).join('\n       ')); }
}

function makeCtx() {
  const store = {};
  const ls = {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  const win = {};
  const ctx = {
    window: win, localStorage: ls, console, Date, JSON, Math, String, Object, Array, isNaN, setTimeout, clearTimeout,
    CustomEvent: function (t) { this.type = t; },
    document: { body: { getAttribute: () => 'none' }, addEventListener() {}, getElementById: () => null, querySelector: () => null, createElement: () => ({ style: {} }) }
  };
  win.localStorage = ls;
  win.dispatchEvent = () => {};
  vm.createContext(ctx);
  ['children.js', 'usage.js'].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', f), 'utf8'), ctx, { filename: f });
  });
  return { win, ls, CC: win.CnmChildren, U: win.CnmUsage };
}
function addKid(CC, name) {
  const r = CC.add({ name, grade: '五年级', term: '上', textbook: '人教版' });
  assert.ok(r.ok, r.error);
  return r.child.id;
}

test('记两次：一次 1200 token 出题、一次 800 批改，合计 2000', () => {
  const { CC, U } = makeCtx();
  const kid = addKid(CC, '小满');
  U.record({ kind: '出题', childId: kid, prompt: 800, completion: 400, total: 1200 });
  U.record({ kind: '批改', childId: kid, prompt: 600, completion: 200, total: 800 });
  const s = U.summary();
  assert.strictEqual(s.total.calls, 2);
  assert.strictEqual(s.total.t, 2000);
  assert.strictEqual(s.total.p, 1400);
  assert.strictEqual(s.total.c, 600);
  assert.strictEqual(s.total.kinds['出题'].t, 1200);
  assert.strictEqual(s.total.kinds['批改'].calls, 1);
  assert.strictEqual(s.kids.length, 1);
  assert.strictEqual(s.kids[0].all.t, 2000);
});

test('没上传 total 时用输入 + 输出补上', () => {
  const { CC, U } = makeCtx();
  const kid = addKid(CC, '小满');
  U.record({ kind: '出题', childId: kid, prompt: 100, completion: 50 });
  assert.strictEqual(U.summary().total.t, 150);
});

test('没拿到用量：计数 +1，token 记 0，并标成 unknown', () => {
  const { CC, U } = makeCtx();
  const kid = addKid(CC, '小满');
  U.record({ kind: '出题', childId: kid, unknown: true });
  const s = U.summary();
  assert.strictEqual(s.total.calls, 1);
  assert.strictEqual(s.total.t, 0);
  assert.strictEqual(s.total.u, 1);
});

test('没有归属孩子：进本机桶，也计入总数', () => {
  const { CC, U } = makeCtx();
  U.record({ kind: '出题', childId: '', prompt: 300, completion: 100, total: 400 });
  const s = U.summary();
  assert.strictEqual(s.total.t, 400);
  assert.strictEqual(s.kids.length, 0);
  assert.strictEqual(s.total.calls, 1);
});

test('两个孩子的用量分开算，合计是两者之和', () => {
  const { CC, U } = makeCtx();
  const a = addKid(CC, '甲');
  const b = addKid(CC, '乙');
  U.record({ kind: '出题', childId: a, prompt: 100, completion: 100, total: 200 });
  U.record({ kind: '出题', childId: b, prompt: 900, completion: 900, total: 1800 });
  const s = U.summary();
  assert.strictEqual(s.total.t, 2000);
  assert.strictEqual(s.kids.length, 2);
  assert.strictEqual(s.kids[0].all.t, 1800);   // 按量排序，多的在前
});

test('跨设备合并：同一天两台设备各 3 次，合起来 6 次；重复合并不会翻倍', () => {
  const { CC, U } = makeCtx();
  const kid = addKid(CC, '小满');
  const day = new Date();
  const p = n => ('0' + n).slice(-2);
  const key = day.getFullYear() + '-' + p(day.getMonth() + 1) + '-' + p(day.getDate());

  const dayA = { devices: { 'dev-a': { calls: 3, p: 300, c: 300, t: 600, u: 0, kinds: { '出题': { calls: 3, p: 300, c: 300, t: 600, u: 0 } } } } };
  const dayB = { devices: { 'dev-b': { calls: 3, p: 100, c: 100, t: 200, u: 0, kinds: { '批改': { calls: 3, p: 100, c: 100, t: 200, u: 0 } } } } };

  let merged = { };
  merged[key] = dayA;
  const twice = U.mergeDays(merged, (function () { const o = {}; o[key] = dayB; return o; })());
  assert.strictEqual(U.callsOf(twice), 6);
  assert.strictEqual(twice[key].devices['dev-a'].t, 600);
  assert.strictEqual(twice[key].devices['dev-b'].t, 200);
  // 再合一次同样的数据：还是 6
  const again = U.mergeDays(twice, (function () { const o = {}; o[key] = dayB; return o; })());
  assert.strictEqual(U.callsOf(again), 6);
});

test('同一台设备重合同一天：取最大值（设备自己的计数只会往上长）', () => {
  const { U } = makeCtx();
  const a = { d1: { devices: { x: { calls: 2, p: 20, c: 30, t: 50, u: 0, kinds: { 出题: { calls: 2, p: 20, c: 30, t: 50, u: 0 } } } } } };
  const b = { d1: { devices: { x: { calls: 5, p: 50, c: 80, t: 130, u: 0, kinds: { 出题: { calls: 5, p: 50, c: 80, t: 130, u: 0 } } } } } };
  const m = U.mergeDays(a, b);
  assert.strictEqual(m.d1.devices.x.calls, 5);
  assert.strictEqual(m.d1.devices.x.t, 130);
});

test('用量作为一条 usage:ai 记录挂在孩子档案里（能跟着云同步走）', () => {
  const { CC, U } = makeCtx();
  const kid = addKid(CC, '小满');
  U.record({ kind: '出题', childId: kid, prompt: 10, completion: 20, total: 30 });
  const rec = CC.recordsOf(kid).find(r => r.key === 'usage:ai');
  assert.ok(rec, '没有 usage:ai 记录');
  assert.strictEqual(rec.kind, 'usage');
  const day = Object.keys(rec.days)[0];
  assert.ok(rec.days[day].devices);
  // 并且不会被当成一次诊断
  assert.strictEqual(CC.isDiagRecord(rec), false);
});

test('数字格式化：四位数原样、上万用万', () => {
  const { U } = makeCtx();
  assert.strictEqual(U.fmt(386), '386');
  assert.strictEqual(U.fmt(12345), '1.2 万');
  assert.strictEqual(U.fmt(1200000), '120 万');
});

console.log('\n' + (failed ? '失败 ' + failed : '全部通过') + '  （' + passed + ' 项）');
process.exit(failed ? 1 : 0);
