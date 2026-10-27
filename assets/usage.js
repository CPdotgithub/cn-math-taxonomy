/* AI 用量统计：把每次模型调用的 token 记下来，按「孩子 / 用途 / 天」汇总。
 * ----------------------------------------------------------------------------
 * 为什么按天 + 按设备存，而不是存一条条调用记录：
 *   - 记录要跟着云同步走，一条条存会越来越大；
 *   - 合并时用「同一天、同一台设备取最大值」就够了（同一台设备的计数只会往上长），
 *     天然幂等，重复同步也不会把数字加两遍。
 *
 * 存储：
 *   挂在孩子档案里的一条记录（key = usage:ai），走现成的云同步；
 *   没有归属孩子的调用（比如还没建档）放本机 cnmUsage.local.v1，不同步。
 *
 * 结构：
 *   { key:'usage:ai', kind:'usage', days: {
 *       '2026-10-27': { devices: { 'dev-xxx': { calls, p, c, t, u, kinds: { 出题: {...} } } } }
 *     } }
 *   p = prompt tokens, c = completion tokens, t = total tokens, u = 没拿到用量的调用次数
 *
 * window.CnmUsage
 */
(function () {
  'use strict';
  var CC = window.CnmChildren;
  var KEY = 'usage:ai';
  var LOCAL_KEY = 'cnmUsage.local.v1';
  var DEV_KEY = 'cnmUsage.device.v1';
  var MAX_DAYS = 365;
  var listeners = [];

  function pad(n) { return ('0' + n).slice(-2); }
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function readJson(k, fb) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch (e) { return fb; }
  }
  function writeJson(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }
  function deviceId() {
    var id = '';
    try { id = localStorage.getItem(DEV_KEY) || ''; } catch (e) { id = ''; }
    if (!id) {
      id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try { localStorage.setItem(DEV_KEY, id); } catch (e) {}
    }
    return id;
  }

  /* ---------------------------------------------------------------- 空桶与累加 */

  function zero() { return { calls: 0, p: 0, c: 0, t: 0, u: 0, kinds: {} }; }
  function add(z, o) {
    z.calls += 1;
    z.p += o.p || 0;
    z.c += o.c || 0;
    z.t += o.t || (o.p || 0) + (o.c || 0);
    if (o.u) z.u += 1;
    var k = o.kind || '其他';
    z.kinds[k] = z.kinds[k] || { calls: 0, p: 0, c: 0, t: 0, u: 0 };
    var b = z.kinds[k];
    b.calls += 1;
    b.p += o.p || 0;
    b.c += o.c || 0;
    b.t += o.t || (o.p || 0) + (o.c || 0);
    if (o.u) b.u += 1;
  }
  function plus(a, b) {
    var out = zero();
    out.calls = (a.calls || 0) + (b.calls || 0);
    out.p = (a.p || 0) + (b.p || 0);
    out.c = (a.c || 0) + (b.c || 0);
    out.t = (a.t || 0) + (b.t || 0);
    out.u = (a.u || 0) + (b.u || 0);
    var ks = {};
    Object.keys(a.kinds || {}).forEach(function (k) { ks[k] = 1; });
    Object.keys(b.kinds || {}).forEach(function (k) { ks[k] = 1; });
    Object.keys(ks).forEach(function (k) {
      out.kinds[k] = plus(a.kinds && a.kinds[k] ? a.kinds[k] : zero(), b.kinds && b.kinds[k] ? b.kinds[k] : zero());
    });
    return out;
  }

  /* ---------------------------------------------------------------- 读写 */

  function usageRecord(childId) {
    if (!CC) return null;
    var arr = CC.recordsOf(childId);
    for (var i = 0; i < arr.length; i++) if (arr[i].key === KEY) return arr[i];
    return null;
  }
  function daysOf(childId) {
    var r = usageRecord(childId);
    return (r && r.days && typeof r.days === 'object') ? r.days : {};
  }
  function localDays() {
    var v = readJson(LOCAL_KEY, null);
    return (v && v.days && typeof v.days === 'object') ? v.days : {};
  }
  function trim(days) {
    var keys = Object.keys(days).sort();
    if (keys.length <= MAX_DAYS) return days;
    var out = {};
    keys.slice(keys.length - MAX_DAYS).forEach(function (k) { out[k] = days[k]; });
    return out;
  }
  function ensureBucket(days, day, dev) {
    var d = days[day] || (days[day] = { devices: {} });
    if (!d.devices) d.devices = {};
    return d.devices[dev] || (d.devices[dev] = zero());
  }

  /* ---------------------------------------------------------------- 记录一次调用 */

  /* o: { kind, childId, model, prompt, completion, total, unknown } */
  function record(o) {
    o = o || {};
    var dev = deviceId();
    var day = dayKey();
    var ev = {
      kind: o.kind || '其他',
      p: Math.max(0, Math.round(o.prompt || 0)),
      c: Math.max(0, Math.round(o.completion || 0)),
      t: Math.max(0, Math.round(o.total || 0)),
      u: o.unknown ? 1 : 0
    };
    var childId = o.childId && CC && CC.get(o.childId) ? o.childId : '';
    if (childId) {
      var rec = usageRecord(childId);
      if (!rec) rec = { key: KEY, kind: 'usage', subject: '', label: 'AI 用量', days: {} };
      rec.days = rec.days || {};
      add(ensureBucket(rec.days, day, dev), ev);
      rec.days = trim(rec.days);
      rec.updatedAt = new Date().toISOString();
      rec.savedAt = rec.savedAt || rec.updatedAt;
      CC.saveRecord(childId, rec);        // 会触发自动云同步
    } else {
      var loc = readJson(LOCAL_KEY, { days: {} });
      if (!loc.days) loc.days = {};
      add(ensureBucket(loc.days, day, dev), ev);
      loc.days = trim(loc.days);
      writeJson(LOCAL_KEY, loc);
    }
    try { window.dispatchEvent(new CustomEvent('cnm-usage-changed')); } catch (e) {}
    listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  /* ---------------------------------------------------------------- 汇总 */

  function sumDays(days) {
    var all = zero();
    Object.keys(days || {}).forEach(function (d) {
      var devs = (days[d] && days[d].devices) || {};
      Object.keys(devs).forEach(function (id) { all = plus(all, devs[id]); });
    });
    return all;
  }
  function sumBetween(days, fromKey, toKey) {
    var all = zero();
    Object.keys(days || {}).forEach(function (d) {
      if (fromKey && d < fromKey) return;
      if (toKey && d > toKey) return;
      var devs = (days[d] && days[d].devices) || {};
      Object.keys(devs).forEach(function (id) { all = plus(all, devs[id]); });
    });
    return all;
  }
  function dayAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return d; }

  function byChild() {
    var out = [];
    if (!CC) return out;
    CC.list().forEach(function (c) {
      var s = sumDays(daysOf(c.id));
      if (s.calls) out.push({ id: c.id, name: c.name, all: s });
    });
    return out;
  }

  function summary() {
    var days = {};
    /* 注意：这里是把多个孩子的用量折进同一张表，同一天同一台设备要「相加」，
       不能覆盖（一台设备上两个孩子都在用，覆盖会少算一个孩子）。 */
    function fold(srcDays) {
      Object.keys(srcDays || {}).forEach(function (day) {
        var dst = days[day] || (days[day] = { devices: {} });
        var src = (srcDays[day] && srcDays[day].devices) || {};
        Object.keys(src).forEach(function (dev) {
          dst.devices[dev] = dst.devices[dev] ? plus(dst.devices[dev], src[dev]) : src[dev];
        });
      });
    }
    if (CC) {
      CC.list().forEach(function (c) { fold(daysOf(c.id)); });
    }
    fold(localDays());

    var total = sumDays(days);
    var today = sumBetween(days, dayKey(), dayKey());
    var week = sumBetween(days, dayKey(dayAgo(6)), dayKey());

    var series = [];
    for (var i = 6; i >= 0; i--) {
      var d = dayAgo(i);
      var k = dayKey(d);
      var s = sumBetween(days, k, k);
      series.push({ day: k, label: (d.getMonth() + 1) + '/' + d.getDate(), t: s.t, calls: s.calls });
    }

    var kids = byChild();
    kids.sort(function (a, b) { return b.all.t - a.all.t; });

    return {
      total: total, today: today, week: week, series: series, kids: kids,
      days: Object.keys(days).length,
      devices: (function () {
        var set = {};
        Object.keys(days).forEach(function (d) {
          Object.keys(days[d].devices || {}).forEach(function (id) { set[id] = 1; });
        });
        return Object.keys(set).length;
      })()
    };
  }

  /* ---------------------------------------------------------------- 云端合并
   * 同一天、同一台设备取最大值：设备自己的计数只会往上长，重复合并不会翻倍。
   */
  function mergeDays(localDaysIn, remoteDaysIn) {
    var out = {};
    [localDaysIn || {}, remoteDaysIn || {}].forEach(function (src) {
      Object.keys(src).forEach(function (day) {
        var dst = out[day] || (out[day] = { devices: {} });
        var devs = (src[day] && src[day].devices) || {};
        Object.keys(devs).forEach(function (dev) {
          var a = dst.devices[dev];
          var b = devs[dev];
          if (!a) { dst.devices[dev] = b; return; }
          dst.devices[dev] = {
            calls: Math.max(a.calls || 0, b.calls || 0),
            p: Math.max(a.p || 0, b.p || 0),
            c: Math.max(a.c || 0, b.c || 0),
            t: Math.max(a.t || 0, b.t || 0),
            u: Math.max(a.u || 0, b.u || 0),
            kinds: mergeKinds(a.kinds, b.kinds)
          };
        });
      });
    });
    return trim(out);
  }
  function mergeKinds(a, b) {
    var out = {};
    [a || {}, b || {}].forEach(function (src) {
      Object.keys(src).forEach(function (k) {
        var x = src[k];
        var y = out[k];
        out[k] = y ? {
          calls: Math.max(y.calls || 0, x.calls || 0),
          p: Math.max(y.p || 0, x.p || 0),
          c: Math.max(y.c || 0, x.c || 0),
          t: Math.max(y.t || 0, x.t || 0),
          u: Math.max(y.u || 0, x.u || 0)
        } : x;
      });
    });
    return out;
  }

  /* 供 cloud-sync 用：把云端的用量记录合并进本地孩子档案，返回是否有变化 */
  function mergeFromCloud(childId, cloudRec) {
    if (!CC || !cloudRec || !cloudRec.days) return false;
    var local = usageRecord(childId);
    var mine = (local && local.days) || {};
    var merged = mergeDays(mine, cloudRec.days);
    if (JSON.stringify(merged) === JSON.stringify(mine)) return false;
    var rec = local || { key: KEY, kind: 'usage', subject: '', label: 'AI 用量', days: {} };
    rec.days = merged;
    rec.updatedAt = new Date().toISOString();
    rec.savedAt = rec.savedAt || rec.updatedAt;
    CC.saveRecord(childId, rec);
    return true;
  }

  /* 给人看的格式化：1.2 万 / 386 */
  function fmt(n) {
    n = Math.round(n || 0);
    if (n >= 1000000) return (n / 10000).toFixed(0) + ' 万';
    if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
    return String(n);
  }

  /* 这个 days 里一共记了多少次调用（同步时用来判断「本地是不是比云端更全」） */
  function callsOf(days) {
    var n = 0;
    Object.keys(days || {}).forEach(function (d) {
      var devs = (days[d] && days[d].devices) || {};
      Object.keys(devs).forEach(function (k) { n += (devs[k].calls || 0); });
    });
    return n;
  }

  window.CnmUsage = {
    KEY: KEY,
    record: record,
    summary: summary,
    daysOf: daysOf,
    usageRecord: usageRecord,
    mergeFromCloud: mergeFromCloud,
    mergeDays: mergeDays,
    callsOf: callsOf,
    fmt: fmt,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
