/* 访问密码门：全站首屏要求输入访问密码，通过后才显示内容。
 *
 * 初始密码：123456
 * 修改密码：在本地执行（任意 Node 环境）
 *   node -e "const c=require('crypto');console.log(c.createHash('sha256').update('cnm-gate-v1:'+process.argv[1]).digest('hex'))" 新密码
 * 把输出的哈希替换下面 PASS_HASH 的值即可。
 *
 * 说明（安全边界）：这是纯静态站点，校验在前端完成，只能挡住普通访客，
 * 懂技术的人查看源码可以绕过。适合内部试用/小范围分享，不适合保护敏感数据。
 */
(function () {
  'use strict';

  var SITE = 'cnm-math-taxonomy';
  var SALT = 'cnm-gate-v1:';
  var PASS_HASH = '00847220aa587c230746ac58189197151d6322a13518104a476bdd96ac4b7ae8'; // 123456
  var STORE_KEY = 'cnmGate.' + SITE + '.v1';
  var KEEP_MS = 7 * 24 * 60 * 60 * 1000; // 通过后记住 7 天

  function readPass() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE_KEY));
      if (!v || !v.ok || !(v.exp > Date.now())) return null;
      return v;
    } catch (e) { return null; }
  }
  function savePass(h) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ ok: true, exp: Date.now() + KEEP_MS, k: h || '' })); } catch (e) {}
  }

  /* 把「已经通过密码门」这件事告诉服务端，换一个会话 Cookie。
     接口（存 curl / 题库）要它才肯给数据；静态托管没有这个接口，404 就算了。 */
  /* 后端可能在本机（页面在线上时）：逐个候选试，谁先答应就用谁，并把会话 key 存下来 */
  var API_KEY_LS = 'cnmGate.apiKey.v1';
  var LOCAL_API = 'http://127.0.0.1:8981';

  function apiBases() {
    var localHost = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
    if (localHost) return [location.origin, LOCAL_API];
    /* 线上 https 页面碰不到本机：混合内容 / Private Network Access 会直接拒掉，
       试了也只是往控制台刷两行红字，还拖慢解锁。直接用同源接口。 */
    if (location.protocol === 'https:') return [location.origin];
    return [LOCAL_API, location.origin];
  }

  function apiUnlock(body) {
    if (!body) return Promise.resolve(false);
    var bases = apiBases();
    var i = 0;
    function next() {
      if (i >= bases.length) return Promise.resolve(false);
      var base = bases[i++];
      return fetch(base + '/api/unlock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (r.status === 404 || r.status === 501) return next();
        return r.ok ? r.json() : null;
      }).then(function (j) {
        if (!j || !j.ok) return next();
        if (j.key) { try { localStorage.setItem(API_KEY_LS, j.key); } catch (e) {} }
        return true;
      }).catch(function () { return next(); });
    }
    return next();
  }
  function hex(buf) {
    var out = '';
    for (var i = 0; i < buf.length; i++) out += ('0' + buf[i].toString(16)).slice(-2);
    return out;
  }
  function digest(text) {
    if (!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest)) {
      return Promise.resolve(null); // 非安全上下文（http 非 localhost）无法校验
    }
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(SALT + text))
      .then(function (buf) { return hex(new Uint8Array(buf)); });
  }

  var passed = readPass();
  if (passed) {
    // 已通过：补一次会话；补上了通知页面重新取凭据
    apiUnlock({ h: passed.k }).then(function (yes) {
      if (yes) { try { window.dispatchEvent(new Event('cnm-unlocked')); } catch (e) {} }
    });
    return;
  }

  // 未通过：先隐藏正文，避免内容一闪而过
  document.documentElement.classList.add('cnm-gate-locked');

  function mount() {
    var mask = document.createElement('div');
    mask.className = 'cnm-gate-mask';
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    mask.setAttribute('aria-label', '访问密码');

    mask.innerHTML =
      '<form class="cnm-gate-card" autocomplete="off">' +
        '<div class="cnm-gate-badge">中小学知识图谱</div>' +
        '<h2 class="cnm-gate-title">请输入访问密码</h2>' +
        '<p class="cnm-gate-desc">本站为内部试用，需输入访问密码后进入。</p>' +
        '<input class="cnm-gate-input" type="password" inputmode="numeric" ' +
               'placeholder="访问密码" aria-label="访问密码" autocomplete="current-password">' +
        '<button class="cnm-gate-btn" type="submit">进入</button>' +
        '<p class="cnm-gate-err" role="alert"></p>' +
      '</form>';

    document.body.appendChild(mask);
    document.documentElement.classList.add('cnm-gate-ready');

    var form = mask.querySelector('form');
    var input = mask.querySelector('.cnm-gate-input');
    var err = mask.querySelector('.cnm-gate-err');
    var btn = mask.querySelector('.cnm-gate-btn');
    var busy = false;

    setTimeout(function () { input.focus(); }, 60);

    function fail(msg) {
      err.textContent = msg;
      mask.classList.remove('cnm-gate-shake');
      void mask.offsetWidth; // 重启动画
      mask.classList.add('cnm-gate-shake');
      input.value = '';
      input.focus();
      busy = false;
      btn.disabled = false;
    }

    function ok(h) {
      savePass(h);
      if (h) {
        apiUnlock({ h: h }).then(function (yes) {
          if (yes) { try { window.dispatchEvent(new Event('cnm-unlocked')); } catch (e) {} }
        });
      }
      mask.classList.add('cnm-gate-out');
      setTimeout(function () {
        mask.remove();
        document.documentElement.classList.remove('cnm-gate-locked');
        document.documentElement.classList.remove('cnm-gate-ready');
      }, 320);
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      var val = input.value == null ? '' : String(input.value).trim();
      if (!val) { fail('请输入密码'); return; }
      busy = true;
      btn.disabled = true;
      err.textContent = '';
      digest(val).then(function (h) {
        if (h === null) {
          /* 非 https 的非 localhost（比如用局域网 IP 在手机上打开）拿不到 crypto.subtle，
             本地算不了哈希：交给服务端判定，服务端也没有就只能提示换 https。 */
          return apiUnlock({ pass: val }).then(function (yes) {
            if (yes) { ok(''); return; }
            fail('当前环境无法校验密码，请用 https 或 127.0.0.1 访问');
          });
        }
        if (h === PASS_HASH) { ok(h); return; }
        fail('密码不正确，请重试');
      }).catch(function () { fail('校验失败，请重试'); });
    });

    input.addEventListener('input', function () {
      if (err.textContent) err.textContent = '';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
