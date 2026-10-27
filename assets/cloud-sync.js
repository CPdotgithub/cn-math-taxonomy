/* 档案云同步：登录后把孩子档案和诊断记录同步到云端（按账号隔离，RLS 保证只有本人能读写）。
 * 未登录时行为与原来完全一致——数据只在本机 localStorage，不上传。
 *
 * 依赖：
 *   assets/cloud-config.js  → window.CNM_CLOUD_CONFIG（部署时生成的 publicConfig）
 *   CDN 脚本                → window.WorkBuddyCloud（@tencent-ai/workbuddy-cloud-sdk）
 *   assets/children.js      → window.CnmChildren（本地档案存储，先于本脚本加载）
 *
 * 暴露 window.CnmSync，并向 window 派发 'cnm-sync-changed' 事件（本地数据被云端更新后）。
 *
 * 设计：本地优先 + 全量 diff 同步。
 *   - 增/改：每次同步时本地与云端逐条按 updated_at 做 LWW 比较，新的赢；
 *   - 删：删除意图先进本地 outbox（localStorage），同步时写成云端墓碑（deleted_at），
 *         墓碑也会同步给其他设备，避免“删了又复活”；
 *   - current（当前孩子）只是本机偏好，不同步。
 */
(function () {
  'use strict';

  var CC = window.CnmChildren;
  var CFG = window.CNM_CLOUD_CONFIG;
  if (!CC || !CFG || !CFG.endpoint || !CFG.publishableKey) return; // 无配置：纯本地模式，不注入任何 UI

  /* ---------------------------------------------------------------- 常量与本地存储 */

  var LS_KEY = 'cnmChildren.v1';        // 与 children.js 一致：{ v, current, children[] }
  var LS_REC = 'cnmChildren.records.v1';// 与 children.js 一致：{ childId: rec[] }
  var MAX_RECORDS = 40;                 // 与 children.js 一致
  var META_KEY = 'cnmSync.meta.v1';
  var OUTBOX_KEY = 'cnmSync.outbox.v1';
  var SYNC_DEBOUNCE_MS = 1500;
  var REFRESH_MIN_GAP_MS = 20000;

  function lsRead(k, fb) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch (e) { return fb; }
  }
  function lsWrite(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }
  function nowIso() { return new Date().toISOString(); }
  function ts(v) { var t = Date.parse(v || ''); return isNaN(t) ? 0 : t; }
  function pad(n) { return ('0' + n).slice(-2); }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  /* 最近同步是多久以前——比一个绝对时间更容易看出「还在不在同步」 */
  function agoText(iso) {
    var t = ts(iso);
    if (!t) return '';
    var diff = Date.now() - t;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return (new Date(t).getMonth() + 1) + '-' + pad(new Date(t).getDate());
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var meta = lsRead(META_KEY, {}) || {};
  meta.lastSyncAt = meta.lastSyncAt || null;
  meta.lastError = meta.lastError || null;
  function saveMeta() { lsWrite(META_KEY, meta); }

  var outbox = lsRead(OUTBOX_KEY, []);
  if (!Array.isArray(outbox)) outbox = [];
  function saveOutbox() { lsWrite(OUTBOX_KEY, outbox); }
  function pushIntent(op) {
    outbox.push(Object.assign({ at: nowIso() }, op));
    if (outbox.length > 500) outbox = outbox.slice(-500);
    saveOutbox();
  }

  /* ---------------------------------------------------------------- 状态与订阅 */

  var mode = 'anon';        // anon | user | local（local = SDK 加载失败，仅本机）
  var cloud = null;
  var session = null;
  var syncing = false;
  var lastError = meta.lastError;
  var listeners = [];

  function snapshot() {
    return {
      mode: mode,
      user: session && session.user ? { name: session.user.name || '' } : null,
      syncing: syncing,
      error: lastError,
      lastSyncAt: meta.lastSyncAt,
      pending: outbox.length,
      retryAt: syncing ? null : (meta.retryAt || null)
    };
  }
  function emit() {
    var s = snapshot();
    listeners.forEach(function (fn) { try { fn(s); } catch (e) { /* 忽略单个监听器错误 */ } });
  }
  function onChange(fn) { listeners.push(fn); }

  /* ---------------------------------------------------------------- SDK 初始化 */

  /* 云端登录只认发布后的正式域名：本机地址（含预览面板里的临时端口）一律只走本机存档 */
  function cloudOriginOk() {
    try {
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
      var h = location.hostname;
      if (!h || h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]' || h === '::1') return false;
      if (/\.local$/i.test(h)) return false;
      if (/^(10|127)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
      return true;
    } catch (e) { return false; }
  }

  function initCloud() {
    if (window.__CNM_SDK_FAILED || !window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
      return null;
    }
    /* 本机 / 预览地址不碰云通道：SDK 在这种地址上会弹「当前地址暂不支持此登录方式」，
       而存档本来就是本机的，没必要为它挡路。 */
    if (!cloudOriginOk()) return null;
    try {
      return window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
        publishableKey: CFG.publishableKey
      });
    } catch (e) {
      return null;
    }
  }

  /* ---------------------------------------------------------------- 同步引擎 */

  function findChild(rows, id) {
    for (var i = 0; i < rows.length; i++) if (rows[i].child_id === id) return rows[i];
    return null;
  }
  function findRec(rows, cid, key) {
    for (var i = 0; i < rows.length; i++) if (rows[i].child_id === cid && rows[i].rec_key === key) return rows[i];
    return null;
  }
  function bySavedAtDesc(a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); }

  /* 删除意向 → 云端墓碑。d-child 会级联墓碑该孩子的全部记录。 */
  async function applyIntents(cloudKids, cloudRecs) {
    if (!outbox.length) return;
    var remaining = [];
    for (var i = 0; i < outbox.length; i++) {
      var op = outbox[i];
      try {
        if (op.t === 'd-child') {
          var row = findChild(cloudKids, op.id);
          if (row && !row.deleted_at && ts(row.updated_at) < ts(op.at)) {
            var r1 = await cloud.database.from('cnm_children').update({ deleted_at: op.at }).eq('id', row.id).select();
            if (r1.error) throw r1.error;
            row.deleted_at = op.at;
            var kids = cloudRecs.filter(function (r) { return r.child_id === op.id && !r.deleted_at; });
            for (var j = 0; j < kids.length; j++) {
              var r2 = await cloud.database.from('cnm_records').update({ deleted_at: op.at }).eq('id', kids[j].id).select();
              if (r2.error) throw r2.error;
              kids[j].deleted_at = op.at;
            }
          }
        } else if (op.t === 'd-rec') {
          var rec = findRec(cloudRecs, op.c, op.k);
          if (rec && !rec.deleted_at && ts(rec.updated_at) < ts(op.at)) {
            var r3 = await cloud.database.from('cnm_records').update({ deleted_at: op.at }).eq('id', rec.id).select();
            if (r3.error) throw r3.error;
            rec.deleted_at = op.at;
          }
        }
      } catch (e) {
        remaining.push(op); // 失败保留，下次同步重试
      }
    }
    outbox = remaining;
    saveOutbox();
  }

  /* 云端 → 本地合并（LWW）。返回是否有变化。 */
  function mergeIntoLocal(cloudKids, cloudRecs) {
    var changed = { kids: 0, recs: 0 };

    var st = lsRead(LS_KEY, null);
    if (!st || !Array.isArray(st.children)) st = { v: 1, current: null, children: [] };
    var byId = {};
    st.children.forEach(function (c) { byId[c.id] = c; });

    cloudKids.forEach(function (row) {
      var local = byId[row.child_id];
      if (row.deleted_at) {
        if (local && ts(row.deleted_at) > ts(local.updatedAt || local.createdAt)) {
          delete byId[row.child_id];
          changed.kids++;
        }
        return;
      }
      if (!local) {
        byId[row.child_id] = {
          id: row.child_id, name: row.name, grade: row.grade, textbook: row.textbook,
          createdAt: row.created_at, updatedAt: row.updated_at
        };
        changed.kids++;
        return;
      }
      if (ts(row.updated_at) > ts(local.updatedAt || local.createdAt)) {
        local.name = row.name;
        local.grade = row.grade;
        local.textbook = row.textbook;
        local.updatedAt = row.updated_at;
        if (!local.createdAt) local.createdAt = row.created_at;
        changed.kids++;
      }
    });
    st.children = Object.keys(byId).map(function (k) { return byId[k]; });
    if (st.current && !byId[st.current]) st.current = st.children.length ? st.children[0].id : null;
    lsWrite(LS_KEY, st);

    var recs = lsRead(LS_REC, null);
    if (!recs || typeof recs !== 'object' || Array.isArray(recs)) recs = {};
    cloudRecs.forEach(function (row) {
      var arr = Array.isArray(recs[row.child_id]) ? recs[row.child_id] : [];
      var idx = -1;
      for (var i = 0; i < arr.length; i++) if (arr[i].key === row.rec_key) { idx = i; break; }
      var local = idx >= 0 ? arr[idx] : null;

      /* AI 用量：两台设备各自计数，合并不是「谁新谁赢」，而是逐日逐设备取最大值 */
      if (row.rec_key === 'usage:ai' && !row.deleted_at) {
        var U = window.CnmUsage;
        if (!U) return;
        var mine = (local && local.days) || {};
        var merged = U.mergeDays(mine, (row.payload || {}).days || {});
        if (JSON.stringify(merged) !== JSON.stringify(mine)) {
          var rec = Object.assign({}, local || { key: 'usage:ai', kind: 'usage', subject: '', label: 'AI 用量' });
          rec.days = merged;
          rec.updatedAt = nowIso();
          rec.savedAt = rec.savedAt || rec.updatedAt;
          if (idx >= 0) arr[idx] = rec; else arr.push(rec);
          recs[row.child_id] = arr;
          changed.recs++;
        }
        return;
      }

      if (row.deleted_at) {
        if (local && ts(row.deleted_at) > ts(local.updatedAt || local.savedAt)) {
          arr.splice(idx, 1);
          changed.recs++;
        }
        return;
      }
      var payload = row.payload || {};
      var rec = Object.assign({}, payload);
      rec.key = rec.key || row.rec_key;
      rec.savedAt = rec.savedAt || row.saved_at;
      rec.updatedAt = rec.updatedAt || row.updated_at;
      if (!local) { arr.push(rec); changed.recs++; }
      else if (ts(row.updated_at) > ts(local.updatedAt || local.savedAt)) { arr[idx] = rec; changed.recs++; }
      arr.sort(bySavedAtDesc);
      recs[row.child_id] = arr.slice(0, MAX_RECORDS);
    });
    lsWrite(LS_REC, recs);

    return changed;
  }

  /* 本地 → 云端推送（insert / update，RLS 结果校验）。 */
  async function pushDiff(cloudKids, cloudRecs) {
    var st = lsRead(LS_KEY, { v: 1, current: null, children: [] });
    var localById = {};
    st.children.forEach(function (c) { localById[c.id] = c; });
    var cloudById = {};
    cloudKids.forEach(function (r) { cloudById[r.child_id] = r; });

    var inserts = [], updates = [];
    Object.keys(localById).forEach(function (id) {
      var c = localById[id];
      var row = cloudById[id];
      var localTs = ts(c.updatedAt || c.createdAt);
      var fields = {
        child_id: id, name: c.name || '', grade: c.grade || '', textbook: c.textbook || '',
        created_at: c.createdAt || nowIso(),
        updated_at: c.updatedAt || c.createdAt || nowIso(),
        deleted_at: null
      };
      if (!row) { inserts.push(fields); return; }
      var newer = row.deleted_at ? ts(row.deleted_at) < localTs : ts(row.updated_at) < localTs;
      /* 只把 row.id 当 where 条件，绝不放进 SET：id 是 identity 列，
         带上它 Postgres 会直接报 column "id" can only be updated to DEFAULT。 */
      if (newer) updates.push({ id: row.id, fields: fields });
    });
    if (inserts.length) {
      var r = await cloud.database.from('cnm_children').insert(inserts).select();
      if (r.error) throw r.error;
      if (!Array.isArray(r.data) || r.data.length !== inserts.length) throw new Error('档案写入云端未生效');
    }
    for (var i = 0; i < updates.length; i++) {
      var u = updates[i];
      var r2 = await cloud.database.from('cnm_children').update(u.fields).eq('id', u.id).select();
      if (r2.error) throw r2.error;
      if (!Array.isArray(r2.data) || !r2.data.length) throw new Error('档案更新云端未生效');
    }

    var recs = lsRead(LS_REC, {});
    var cloudByKey = {};
    cloudRecs.forEach(function (r) { cloudByKey[r.child_id + '\u0000' + r.rec_key] = r; });
    var rInserts = [], rUpdates = [];
    Object.keys(recs).forEach(function (cid) {
      var arr = Array.isArray(recs[cid]) ? recs[cid] : [];
      arr.forEach(function (rec) {
        if (!rec || !rec.key) return;
        var row = cloudByKey[cid + '\u0000' + rec.key];
        var localTs = ts(rec.updatedAt || rec.savedAt);
        var fields = {
          child_id: cid, rec_key: rec.key, payload: rec,
          saved_at: rec.savedAt || nowIso(),
          updated_at: rec.updatedAt || rec.savedAt || nowIso(),
          deleted_at: null
        };
        if (!row) { rInserts.push(fields); return; }
        var newer = row.deleted_at ? ts(row.deleted_at) < localTs : ts(row.updated_at) < localTs;
        /* 用量记录：只要本地累计的调用次数比云端多，就该推上去（updated_at 先后不代表数据更全） */
        if (rec.key === 'usage:ai' && window.CnmUsage) {
          var localCalls = window.CnmUsage.callsOf(rec.days);
          var cloudCalls = window.CnmUsage.callsOf(((row.payload || {}).days) || {});
          if (localCalls > cloudCalls) newer = true;
        }
        if (newer) rUpdates.push({ id: row.id, fields: fields });
      });
    });
    if (rInserts.length) {
      var r3 = await cloud.database.from('cnm_records').insert(rInserts).select();
      if (r3.error) throw r3.error;
      if (!Array.isArray(r3.data) || r3.data.length !== rInserts.length) throw new Error('诊断记录写入云端未生效');
    }
    for (var j = 0; j < rUpdates.length; j++) {
      var ru = rUpdates[j];
      var r4 = await cloud.database.from('cnm_records').update(ru.fields).eq('id', ru.id).select();
      if (r4.error) throw r4.error;
      if (!Array.isArray(r4.data) || !r4.data.length) throw new Error('诊断记录更新云端未生效');
    }
  }

  function friendlyError(e) {
    var msg = (e && e.message) ? String(e.message) : '';
    if (/failed to fetch|networkerror|load failed|timeout/i.test(msg)) {
      return '网络不稳定，同步未完成，稍后会自动重试';
    }
    if (e && (e.code === '42501' || e.code === '401')) {
      return '云端会话已失效，重新登录后会继续同步';
    }
    /* 数据库层的报错别原样丢给家长看，留一句人话 + 自动重试就够了 */
    if (/can only be updated to DEFAULT|violates|permission denied|row-level security|null value in column/i.test(msg)) {
      return '云端这次没接受写入（数据表限制），稍后会自动重试';
    }
    return '同步未完成：' + (msg || '未知错误');
  }

  async function syncNow() {
    if (!cloud || !session || syncing) return;
    syncing = true;
    emit();
    try {
      var kidsRes = await cloud.database.from('cnm_children').select('*');
      if (kidsRes.error) throw kidsRes.error;
      var recsRes = await cloud.database.from('cnm_records').select('*');
      if (recsRes.error) throw recsRes.error;
      var cloudKids = kidsRes.data || [];
      var cloudRecs = recsRes.data || [];

      await applyIntents(cloudKids, cloudRecs);
      var changed = mergeIntoLocal(cloudKids, cloudRecs);
      await pushDiff(cloudKids, cloudRecs);

      meta.lastSyncAt = nowIso();
      meta.lastError = null;
      lastError = null;
      retryIdx = 0;
      meta.retryAt = null;
      saveMeta();
      if (changed.kids || changed.recs) {
        window.dispatchEvent(new CustomEvent('cnm-sync-changed'));
      }
    } catch (e) {
      lastError = friendlyError(e);
      meta.lastError = lastError;
      saveMeta();
      scheduleRetry();     // 失败不让人去点按钮，自己退避重试
    } finally {
      syncing = false;
      emit();
    }
  }

  var syncTimer = null;
  function scheduleSync() {
    if (!session) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncTimer = null; syncNow(); }, SYNC_DEBOUNCE_MS);
  }

  /* 失败后的自动重试：8s → 20s → 1min → 3min → 5min，成功一次就清零 */
  var retryTimer = null;
  var retryIdx = 0;
  var RETRY_STEPS = [8000, 20000, 60000, 180000, 300000];
  function scheduleRetry() {
    if (!session) return;
    if (retryTimer) return;
    var wait = RETRY_STEPS[Math.min(retryIdx, RETRY_STEPS.length - 1)];
    retryIdx++;
    meta.retryAt = Date.now() + wait;
    saveMeta();
    retryTimer = setTimeout(function () {
      retryTimer = null;
      syncNow();
    }, wait);
  }
  function clearRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryIdx = 0;
    meta.retryAt = null;
    saveMeta();
  }

  /* ---------------------------------------------------------------- 登录 / 登出 */

  function loginErrorMessage(e) {
    var msg = (e && e.message) ? String(e.message) : '';
    if (/未打开/.test(msg)) return '该登录方式暂未开放，请换一种方式登录';
    return msg || '登录启动失败，请稍后重试';
  }

  async function login(provider) {
    if (!cloud) return;
    var back = new URL(location.origin + '/');
    var cur = new URLSearchParams(location.search);
    cur.forEach(function (v, k) {
      if (k !== 'code' && k !== 'state' && k !== 'provider' && k !== 'next') back.searchParams.set(k, v);
    });
    back.searchParams.set('next', location.pathname + location.search);
    try {
      sessionStorage.setItem('cnmSync.justLoggedIn', '1');
      var res = await cloud.auth.signInWithOAuth({ provider: provider, redirectTo: back.toString() });
      if (res.error) {
        sessionStorage.removeItem('cnmSync.justLoggedIn');
        lastError = loginErrorMessage(res.error);
        emit();
        return;
      }
      location.assign(res.data.url); // 必须当前标签页跳转（PKCE verifier 在 sessionStorage）
    } catch (e) {
      sessionStorage.removeItem('cnmSync.justLoggedIn');
      lastError = loginErrorMessage(e);
      emit();
    }
  }

  async function logout() {
    if (!cloud) return;
    try { await cloud.auth.signOut(); } catch (e) { /* 忽略：本地照常退出登录态 */ }
    session = null;
    clearRetry();
    emit();
  }

  /* ---------------------------------------------------------------- 启动：回调分发 + 会话恢复 */

  function safeNext(url) {
    var next = url.searchParams.get('next');
    if (!next) return null;
    try { next = decodeURIComponent(next); } catch (e) { return null; }
    if (next.charAt(0) !== '/' || next.charAt(1) === '/') return null; // 只允许站内绝对路径
    return next;
  }

  async function handleCallback() {
    var url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return false;
    var provider = url.searchParams.get('provider');
    if (provider !== 'workbuddy' && provider !== 'wechat') {
      lastError = '授权回调缺少有效的登录方式，请重新登录';
      emit();
      return true;
    }
    var handler = provider === 'workbuddy' ? cloud.auth.handleWorkBuddyCallback : cloud.auth.handleWechatWebCallback;
    if (typeof handler !== 'function') {
      lastError = '暂时无法使用此方式登录，请刷新页面重试';
      emit();
      return true;
    }
    var res = await handler.call(cloud.auth);
    if (res.error) {
      lastError = loginErrorMessage(res.error);
      emit();
      return true;
    }
    if (res.data) {
      ['code', 'state', 'provider'].forEach(function (k) { url.searchParams.delete(k); });
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      session = res.data;
      var next = safeNext(url);
      if (next) { location.replace(next); return true; } // 回跳业务页，同步在那边做
      await syncNow();
      emit();
      return true;
    }
    return true;
  }

  async function restoreSession() {
    try {
      var res = await cloud.auth.getSession();
      session = (res && res.data) || null;
    } catch (e) {
      session = null;
    }
    if (session) await syncNow();
  }

  function showLoginToast() {
    try {
      if (!sessionStorage.getItem('cnmSync.justLoggedIn')) return;
      sessionStorage.removeItem('cnmSync.justLoggedIn');
    } catch (e) { return; }
    var toast = document.createElement('div');
    toast.className = 'cnm-toast';
    toast.textContent = '已登录，档案将自动同步到云端';
    document.body.appendChild(toast);
    setTimeout(function () { toast.classList.add('show'); }, 16);
    setTimeout(function () {
      toast.classList.remove('show');
      setTimeout(function () { toast.remove(); }, 400);
    }, 4000);
  }

  async function boot() {
    cloud = initCloud();
    if (!cloud) { mode = 'local'; emit(); return; }
    try {
      await handleCallback();
      if (!session) await restoreSession();
      mode = session ? 'user' : 'anon';
      if (session) showLoginToast();
      if (cloud.auth.onAuthStateChange) {
        cloud.auth.onAuthStateChange(function (event, sess) {
          var was = !!session;
          session = sess || null;
          mode = session ? 'user' : 'anon';
          if (session && !was) syncNow();
          emit();
        });
      }
    } catch (e) {
      mode = session ? 'user' : 'anon';
    }
    emit();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible' || !session) return;
      if (Date.now() - ts(meta.lastSyncAt) > REFRESH_MIN_GAP_MS) syncNow();
    });
    /* 断网重连立刻补一次，别等退避计时器 */
    window.addEventListener('online', function () {
      if (!session) return;
      clearRetry();
      syncNow();
    });
    /* 失败重试期间每秒刷新一下「还有几秒」 */
    setInterval(function () {
      if (session && meta.retryAt) emit();
    }, 1000);
  }

  /* ---------------------------------------------------------------- 包装 CnmChildren：变更即同步 */

  function wrapMutation(name, after) {
    var orig = CC[name];
    if (typeof orig !== 'function') return;
    CC[name] = function () {
      var r = orig.apply(this, arguments);
      try { after(r, arguments); } catch (e) { /* 不打断业务 */ }
      return r;
    };
  }
  wrapMutation('add', function () { scheduleSync(); });
  wrapMutation('update', function () { scheduleSync(); });
  wrapMutation('saveRecord', function () { scheduleSync(); });

  CC.remove = (function (orig) {
    return function (id) {
      var had = !!CC.get(id);
      orig.call(this, id);
      if (had) pushIntent({ t: 'd-child', id: id });
      scheduleSync();
    };
  })(CC.remove);

  CC.removeRecord = (function (orig) {
    return function (childId, key) {
      var had = CC.hasRecord(childId, key);
      orig.call(this, childId, key);
      if (had) pushIntent({ t: 'd-rec', c: childId, k: key });
      scheduleSync();
    };
  })(CC.removeRecord);

  CC.moveRecord = (function (orig) {
    return function (key, fromId, toId) {
      var had = CC.hasRecord(fromId, key);
      orig.call(this, key, fromId, toId);
      if (had && fromId !== toId) pushIntent({ t: 'd-rec', c: fromId, k: key });
      scheduleSync();
    };
  })(CC.moveRecord);

  /* ---------------------------------------------------------------- UI：档案页同步卡片 */

  function h(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function renderCard(root, s) {
    root.textContent = '';
    var card = h('section', 'sync-card');
    card.id = 'cnm-sync-card';

    var row = h('div', 'sync-row');
    row.appendChild(h('span', 'sync-logo', '☁'));
    var main = h('div', 'sync-main');
    var title = h('p', 'sync-title');
    var stateText;
    if (s.mode === 'local') stateText = '不可用';
    else if (!s.user) stateText = '未登录';
    else if (s.syncing) stateText = '同步中…';
    else if (s.error) stateText = '同步失败 · 自动重试中';
    else stateText = s.lastSyncAt ? '已同步 · ' + agoText(s.lastSyncAt) : '待同步';
    title.innerHTML = '云同步 <span class="sync-state">' + esc(stateText) + '</span>';
    main.appendChild(title);

    var desc = h('p', 'sync-desc');
    if (s.mode === 'local') {
      desc.textContent = '这个地址不支持云同步（本机预览地址常见）。档案和诊断记录照常保存在这台设备的浏览器里，不用登录也能用；换成发布后的网址就能登录同步。';
    } else if (!s.user) {
      desc.textContent = '登录后，孩子档案和诊断记录会自动保存到云端：换设备、清缓存都不丢，多台设备自动合并。未登录时数据不上传。';
    } else {
      desc.textContent = '已登录：' + (s.user.name || '云用户') + '。改动会自动同步，不用手动点' +
        (s.pending ? '；有 ' + s.pending + ' 项正在排队' : '') + '。';
      if (s.error) {
        desc.textContent += ' ' + s.error + (s.retryAt
          ? '（' + Math.max(1, Math.round((s.retryAt - Date.now()) / 1000)) + ' 秒后自动重试）'
          : '');
      }
    }
    main.appendChild(desc);
    row.appendChild(main);

    var actions = h('div', 'sync-actions');
    if (s.mode === 'local') {
      var bk = h('button', 'btn', '导出本机数据');
      bk.type = 'button';
      bk.addEventListener('click', function () {
        if (window.CnmBackup) window.CnmBackup.export();
        else location.hash = '#backup';
      });
      actions.appendChild(bk);
    } else if (!s.user) {
      var wx = h('button', 'btn btn-primary', '微信登录');
      wx.type = 'button';
      wx.addEventListener('click', function () { lastError = null; emit(); login('wechat'); });
      var wb = h('button', 'btn', '使用 WorkBuddy 登录');
      wb.type = 'button';
      wb.addEventListener('click', function () { lastError = null; emit(); login('workbuddy'); });
      actions.appendChild(wx);
      actions.appendChild(wb);
      if (s.error) {
        var err = h('p', 'sync-err', s.error);
        actions.appendChild(err);
      }
    } else {
      var out = h('button', 'btn', '退出登录');
      out.type = 'button';
      out.addEventListener('click', function () {
        if (confirm('退出登录？本地档案会保留，云端数据还在，重新登录即可继续同步。')) logout();
      });
      actions.appendChild(out);
    }
    row.appendChild(actions);
    card.appendChild(row);
    root.appendChild(card);
  }

  /* ---------------------------------------------------------------- UI：历史/诊断页小状态条 */

  function renderChip(root, s) {
    root.textContent = '';
    if (s.mode === 'local') return;
    var chip = h('a', 'cnm-chip');
    chip.id = 'cnm-sync-chip';
    if (!s.user) {
      chip.href = '../children/';
      chip.innerHTML = '☁ 未登录 · 仅本机 <b>去登录</b>';
    } else if (s.syncing) {
      chip.href = 'javascript:void(0)';
      chip.innerHTML = '☁ 同步中…';
    } else if (s.error) {
      chip.href = '../children/';
      chip.innerHTML = '☁ 同步失败 <b>自动重试中</b>';
    } else {
      chip.href = '../children/';
      chip.innerHTML = '☁ 已同步 · ' + esc(s.lastSyncAt ? agoText(s.lastSyncAt) : '--');
    }
    root.appendChild(chip);
  }

  function injectCard() {
    var list = document.getElementById('list');
    if (!list || document.getElementById('cnm-sync-card')) return;
    var lede = document.querySelector('.kids .lede');
    var host = h('div');
    if (lede && lede.parentNode) lede.parentNode.insertBefore(host, lede.nextSibling);
    else list.parentNode.insertBefore(host, list);
    onChange(function (s) { renderCard(host, s); });
  }

  function injectChip() {
    if (document.getElementById('cnm-sync-chip')) return;
    var host = h('div');
    document.body.appendChild(host);
    onChange(function (s) { renderChip(host, s); });
  }

  /* ---------------------------------------------------------------- 启动 */

  var page = document.body.getAttribute('data-page') || '';
  if (page === 'children') injectCard();
  else if (page === 'history' || page === 'diagnose') injectChip();

  boot();

  window.CnmSync = {
    snapshot: snapshot,
    onChange: onChange,
    syncNow: syncNow,
    login: login,
    logout: logout
  };
})();
