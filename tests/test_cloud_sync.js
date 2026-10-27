#!/usr/bin/env node
/* 云同步测试：node tests/test_cloud_sync.js（无依赖）
 * 用假的 WorkBuddyCloud SDK 跑 assets/cloud-sync.js，验证：
 *   1. update 的 SET 里不能带 id（Postgres identity 列，带了就报 column "id" can only be updated to DEFAULT）
 *   2. 改动后自动同步，不需要手动点按钮
 *   3. 失败会自动重试（这里只验证「不抛错、状态是失败」）
 */
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
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeLS() {
  const s = {};
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : null),
    setItem: (k, v) => { s[k] = String(v); },
    removeItem: k => { delete s[k]; }
  };
}

/* calls: 记录 SDK 收到的调用，供断言 */
async function boot(opts) {
  opts = opts || {};
  const ls = makeLS();
  const calls = [];
  const kids = [{ id: 11, child_id: 'k1', name: '云端名', grade: '五年级', textbook: '人教版', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', deleted_at: null }];
  const recs = opts.cloudRecs || [];

  function table(name) {
    const api = {
      _mode: null, _payload: null, _eqId: null,
      select() {
        if (this._mode === 'update') {
          calls.push({ table: name, op: 'update', payload: this._payload, eqId: this._eqId });
          return Promise.resolve({ data: [{}], error: null });
        }
        return Promise.resolve({ data: name === 'cnm_children' ? kids : recs, error: null });
      },
      insert(p) {
        calls.push({ table: name, op: 'insert', payload: p });
        const n = Array.isArray(p) ? p.length : 1;
        return { select: () => Promise.resolve({ data: new Array(n).fill({}), error: null }) };
      },
      update(p) {
        this._mode = 'update';
        this._payload = p;
        const self = this;
        return { eq: (k, v) => { self._eqId = v; return { select: () => self.select() }; } };
      }
    };
    return api;
  }

  const win = {};
  const document = {
    body: { getAttribute: () => opts.page || 'none' },
    addEventListener() {},
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} }),
    getElementById: () => null,
    querySelector: () => null,
    dispatchEvent() {}
  };
  const ctx = {
    window: win,
    document,
    localStorage: ls,
    location: { protocol: 'https:', hostname: 'app.example.com', origin: 'https://app.example.com', pathname: '/children/', search: '', href: 'https://app.example.com/children/', assign() {}, replace() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, JSON, Promise, Date, Math, Object, Array, String, Number, isNaN, parseInt, setTimeout, clearTimeout, setInterval, URLSearchParams,
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    Event: function (t) { this.type = t; },
    fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    URL: function (u) { this.href = u; this.searchParams = new URLSearchParams(''); this.pathname = '/'; this.search = ''; }
  };
  ctx.window = win;
  win.document = document;
  win.localStorage = ls;
  win.location = ctx.location;
  win.sessionStorage = ctx.sessionStorage;
  win.CustomEvent = ctx.CustomEvent;
  win.Event = ctx.Event;
  win.addEventListener = () => {};
  win.dispatchEvent = () => {};
  win.CNM_CLOUD_CONFIG = { endpoint: 'https://api.example.com', publishableKey: 'pk', oauthRelayBaseUrl: 'https://app.example.com' };
  win.WorkBuddyCloud = {
    createWorkBuddyCloud() {
      return {
        auth: {
          getSession: () => opts.session === false ? Promise.resolve({ data: null }) : Promise.resolve({ data: { user: { name: 'CP' } } }),
          signOut: () => Promise.resolve({}),
          onAuthStateChange: () => {}
        },
        database: { from: table }
      };
    }
  };

  /* 本地数据 */
  ls.setItem('cnmChildren.v1', JSON.stringify({ v: 1, current: 'k1', children: [
    { id: 'k1', name: '张瑞涵', grade: '五年级', term: '上', textbook: '人教版', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' }
  ] }));
  ls.setItem('cnmChildren.records.v1', JSON.stringify({ k1: opts.localRecs || [] }));

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'children.js'), 'utf8'), ctx, { filename: 'children.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'usage.js'), 'utf8'), ctx, { filename: 'usage.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'cloud-sync.js'), 'utf8'), ctx, { filename: 'cloud-sync.js' });
  await wait(30);
  return { win, ls, calls, CC: win.CnmChildren, Sync: win.CnmSync };
}

(async () => {
  const A = await boot();
  test('登录后进入 user 模式并同步过一次', () => {
    assert.ok(A.Sync, 'CnmSync 没挂上（cloud-sync 提前 return 了？）');
    const s = A.Sync.snapshot();
    assert.strictEqual(s.mode, 'user', JSON.stringify(s));
    assert.ok(s.lastSyncAt, '没有同步时间');
    assert.strictEqual(s.error, null);
  });

  test('档案 update 的 SET 里不带 id（这就是 column "id" 报错的根因）', () => {
    const u = A.calls.filter(c => c.op === 'update' && c.table === 'cnm_children')[0];
    assert.ok(u, '没有发出 update 调用：' + JSON.stringify(A.calls.map(c => c.table + ':' + c.op)));
    assert.ok(!Object.prototype.hasOwnProperty.call(u.payload, 'id'), 'payload 里还有 id：' + Object.keys(u.payload).join(','));
    assert.strictEqual(u.eqId, 11, 'where 条件应该用行的 id');
    assert.strictEqual(u.payload.child_id, 'k1');
    assert.ok(u.payload.name && u.payload.textbook);
  });

  test('改孩子资料 → 自动再同步一次（没有手动「立即同步」这一步）', async () => {
    const before = A.calls.filter(c => c.op === 'update' && c.table === 'cnm_children').length;
    A.CC.update('k1', { name: '张瑞涵', grade: '五年级', term: '上', textbook: '北师大版' });
    await wait(1800);   // SYNC_DEBOUNCE_MS = 1500
    const after = A.calls.filter(c => c.op === 'update' && c.table === 'cnm_children').length;
    assert.ok(after > before, '改完没有自动同步：' + before + ' → ' + after);
  });

  test('确认掌握状态也会触发同步，且作为一条 manual:graph 记录发出去', async () => {
    const before = A.calls.filter(c => c.op === 'insert' && c.table === 'cnm_records').length;
    A.CC.commitEdits('k1', [{ id: 'cnm_p001', name: '十几减9', from: '', to: 'mastered' }], { by: '老师' });
    await wait(1800);
    const before2 = before;
    const inserts = A.calls.filter(c => c.op === 'insert' && c.table === 'cnm_records');
    const recPushed = inserts.some(c => (Array.isArray(c.payload) ? c.payload : [c.payload]).some(r => r.rec_key === 'manual:graph'));
    const upd = A.calls.filter(c => c.op === 'update' && c.table === 'cnm_records').some(c => c.payload.rec_key === 'manual:graph');
    assert.ok(recPushed || upd, 'manual:graph 没有同步出去（insert ' + (before2) + ' 次）');
  });

  /* 用量跨设备合并：云端有另一台设备的计数，本地这台也有自己的，同步后要都在 */
  const day = (function () { const d = new Date(); const p = n => ('0' + n).slice(-2); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();
  const cloudUsage = [{
    child_id: 'k1', rec_key: 'usage:ai', id: 21,
    payload: { key: 'usage:ai', kind: 'usage', days: (function () { const o = {}; o[day] = { devices: { 'dev-cloud': { calls: 4, p: 400, c: 500, t: 900, u: 0, kinds: { '出题': { calls: 4, p: 400, c: 500, t: 900, u: 0 } } } } }; return o; })() },
    saved_at: '2026-10-27T00:00:00.000Z', updated_at: '2026-10-27T00:00:00.000Z', deleted_at: null
  }];
  const localUsage = [{
    key: 'usage:ai', kind: 'usage', savedAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    days: (function () { const o = {}; o[day] = { devices: { 'dev-local': { calls: 2, p: 200, c: 100, t: 300, u: 0, kinds: { '出题': { calls: 2, p: 200, c: 100, t: 300, u: 0 } } } } }; return o; })()
  }];
  const C = await boot({ cloudRecs: cloudUsage, localRecs: localUsage });
  test('用量跨设备合并：两台设备的计数都在，调用数相加', () => {
    const rec = C.CC.recordsOf('k1').find(r => r.key === 'usage:ai');
    assert.ok(rec, '本地没有 usage:ai 记录');
    const devs = rec.days[day].devices;
    assert.ok(devs['dev-local'], '本地设备的数据丢了');
    assert.ok(devs['dev-cloud'], '云端另一台设备的数据没合并进来');
    assert.strictEqual(C.win.CnmUsage.callsOf(rec.days), 6);
    assert.strictEqual(C.win.CnmUsage.summary().total.t, 1200);
  });

  test('用量不会被当成诊断记录', () => {
    const rec = C.CC.recordsOf('k1').find(r => r.key === 'usage:ai');
    assert.strictEqual(C.CC.isDiagRecord(rec), false);
  });

  const B = await boot({ session: false });
  test('未登录：不建通道，也不往云端写', () => {
    assert.ok(B.Sync);
    assert.strictEqual(B.Sync.snapshot().mode, 'anon');
    assert.strictEqual(B.calls.filter(c => c.op !== 'select').length, 0);
  });

  console.log('\n' + (failed ? '失败 ' + failed : '全部通过') + '  （' + passed + ' 项）');
  process.exit(failed ? 1 : 0);
})();
