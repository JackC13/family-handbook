/* 家庭旅行說明書：解鎖、表單儲存與同步。
 * 內容以 AES-GCM 加密（見 encrypt.js）；打勾與填寫先存在這台裝置，
 * 有網路時用 POST 同步到 Google Apps Script（見 apps-script/Code.gs）。 */
(function () {
  'use strict';

  var STORE = 'trip-manual-v1';
  var UNLOCK = 'trip-unlock-v1';
  var TOKEN_SALT = 'trip-sync-v1';
  var te = new TextEncoder();
  var td = new TextDecoder();

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function b64(buf) { var a = new Uint8Array(buf), s = ''; for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(s) { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function hhmm(t) { var d = new Date(t); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  var P = JSON.parse($('#payload').textContent);

  // ---------- 解鎖 ----------

  async function pbkdf2(pw, salt, iter) {
    var base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
    return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iter }, base, 256);
  }

  async function decryptWith(raw) {
    var key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(P.iv) }, key, unb64(P.ct));
    return JSON.parse(td.decode(pt));
  }

  var form = $('#lock-form');
  var msg = $('#lock-msg');

  if (!window.crypto || !crypto.subtle) {
    msg.textContent = '這個瀏覽器沒辦法解密。請用 Safari 或 Chrome 打開 https 網址。';
    form.hidden = true;
  } else {
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var pw = $('#lock-pw').value;
      if (!pw) return;
      var btn = $('button', form);
      btn.disabled = true;
      msg.textContent = '解鎖中…';
      try {
        var raw = await pbkdf2(pw, unb64(P.salt), P.iter);
        var data = await decryptWith(raw);
        var token = hex(await pbkdf2(pw, te.encode(TOKEN_SALT), P.iter));
        if ($('#lock-remember').checked) lsSet(UNLOCK, { s: P.salt, k: b64(raw), t: token });
        start(data, token);
      } catch (err) {
        msg.textContent = '密碼不對，請再試一次。';
        btn.disabled = false;
      }
    });
    (async function () {
      var u = lsGet(UNLOCK, null);
      if (!u || u.s !== P.salt) return;
      try { start(await decryptWith(unb64(u.k)), u.t); } catch (e) { lsDel(UNLOCK); }
    })();
  }

  var started = false;
  function start(data, token) {
    if (started) return;
    started = true;
    document.title = data.title || document.title;
    $('#lock').hidden = true;
    var app = $('#app');
    app.innerHTML = data.html;
    app.hidden = false;
    App.init(data, token);
    if (location.hash) {
      var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) target.scrollIntoView();
    }
  }

  // ---------- 表單與同步 ----------

  var App = {
    init: function (data, token) {
      var self = this;
      this.fields = data.fields || {};
      this.url = (data.config && data.config.syncUrl) || '';
      this.token = token;
      this.s = lsGet(STORE, { values: {}, dirty: {}, who: '', last: 0 });
      this.state = 'idle';
      this.bind();
      this.applyAll();
      if (!this.s.who) setTimeout(function () { self.askWho(); }, 300);
      this.renderStatus();
      if (this.url) {
        this.sync();
        setInterval(function () { if (document.visibilityState === 'visible') self.sync(); }, 60000);
        window.addEventListener('online', function () { self.sync(); });
        window.addEventListener('offline', function () { self.state = 'offline'; self.renderStatus(); });
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') self.sync(); });
      }
    },

    bind: function () {
      var self = this, app = $('#app');
      app.addEventListener('change', function (ev) {
        var el = ev.target;
        if (el.matches('input[type="checkbox"][data-id]')) self.local(el, false);
      });
      app.addEventListener('input', function (ev) {
        var el = ev.target;
        if (el.matches('input[type="text"][data-id]')) self.local(el, true);
      });
      $('#btn-todo').addEventListener('click', function () {
        var on = document.body.classList.toggle('only-todo');
        this.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      $('#btn-sync').addEventListener('click', function () { self.sync(); self.closeMenu(); });
      $('#btn-who').addEventListener('click', function () { self.askWho(); self.closeMenu(); });
      $('#btn-lock').addEventListener('click', function () {
        if (confirm('鎖定後，這台裝置下次要重新輸入家庭密碼。已填的資料不會刪除。')) { lsDel(UNLOCK); location.reload(); }
      });
    },

    closeMenu: function () { var d = $('.menu'); if (d) d.open = false; },

    askWho: function () {
      var w = prompt('這台裝置是誰在用？會記在試算表的「修改者」欄（例如：老公、老婆）', this.s.who || '');
      if (w !== null && w.trim()) { this.s.who = w.trim(); lsSet(STORE, this.s); }
    },

    read: function (el) { return el.type === 'checkbox' ? (el.checked ? '✓' : '') : el.value; },

    // 正在輸入的欄位會被標成待同步，merge 會跳過它，所以這裡不用再擋游標所在的欄位；
    // 只在值真的不同時才更新，避免游標跳到最後
    write: function (el, v) {
      if (el.type === 'checkbox') el.checked = (v === '✓' || v === '1');
      else if (el.value !== v) el.value = v;
    },

    applyAll: function () {
      var self = this;
      $$('[data-id]').forEach(function (el) {
        var r = self.s.values[el.getAttribute('data-id')];
        if (r) self.write(el, r.v);
      });
      this.refresh();
    },

    refresh: function () {
      $$('.task').forEach(function (t) {
        var cb = $('input[type="checkbox"]', t);
        t.classList.toggle('done', !!(cb && cb.checked));
      });
      var boxes = $$('input[type="checkbox"][data-id]');
      var done = boxes.filter(function (b) { return b.checked; }).length;
      $('#prog').textContent = '完成 ' + done + ' / ' + boxes.length;
      $$('[data-cp]').forEach(function (el) {
        var c = el.getAttribute('data-cp');
        var bs = $$('section[data-chap="' + c + '"] input[type="checkbox"][data-id]');
        if (!bs.length) { el.textContent = ''; return; }
        var d = bs.filter(function (b) { return b.checked; }).length;
        el.textContent = d + '/' + bs.length;
        el.classList.toggle('all', d === bs.length);
      });
    },

    local: function (el, typing) {
      var self = this, id = el.getAttribute('data-id');
      this.s.values[id] = { v: this.read(el), at: Date.now(), by: this.s.who };
      this.s.dirty[id] = 1;
      lsSet(STORE, this.s);
      if (!typing) this.refresh();
      this.renderStatus();
      clearTimeout(this.timer);
      this.timer = setTimeout(function () { self.sync(); }, typing ? 2500 : 800);
    },

    call: async function (body) {
      body.token = this.token;
      var res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var j = await res.json();
      if (!j.ok) throw new Error(j.error || '同步失敗');
      return j;
    },

    sync: async function () {
      if (!this.url || this.busy) return;
      if (!navigator.onLine) { this.state = 'offline'; this.renderStatus(); return; }
      var self = this;
      this.busy = true;
      this.state = 'syncing';
      this.renderStatus();
      try {
        var ids = Object.keys(this.s.dirty), rows;
        if (ids.length) {
          var sent = {};
          var changes = ids.map(function (id) {
            var v = self.s.values[id] || { v: '', at: Date.now() };
            var f = self.fields[id] || {};
            sent[id] = v.at;
            return { id: id, v: v.v, at: v.at, chap: f.chap || '', label: f.label || id };
          });
          rows = (await this.call({ action: 'push', who: this.s.who, changes: changes })).rows;
          ids.forEach(function (id) { if (self.s.values[id] && self.s.values[id].at === sent[id]) delete self.s.dirty[id]; });
        } else {
          rows = (await this.call({ action: 'pull' })).rows;
        }
        this.merge(rows);
        this.s.last = Date.now();
        lsSet(STORE, this.s);
        this.state = 'ok';
        this.err = '';
      } catch (err) {
        this.state = navigator.onLine ? 'error' : 'offline';
        this.err = String((err && err.message) || err);
      } finally {
        this.busy = false;
        this.renderStatus();
      }
    },

    merge: function (rows) {
      var self = this, changed = false;
      (rows || []).forEach(function (r) {
        if (self.s.dirty[r.id]) return;
        var cur = self.s.values[r.id];
        if (!cur || r.at > cur.at || (r.v !== cur.v && r.at >= cur.at - 1000)) {
          self.s.values[r.id] = { v: r.v, at: r.at, by: r.by };
          var el = document.querySelector('[data-id="' + CSS.escape(r.id) + '"]');
          if (el) self.write(el, r.v);
          changed = true;
        }
      });
      if (changed) this.refresh();
    },

    renderStatus: function () {
      var el = $('#sync');
      if (!el) return;
      var n = Object.keys(this.s.dirty).length;
      var text, cls = '';
      if (!this.url) text = '只存在這台裝置';
      else if (this.state === 'syncing') text = '同步中…';
      else if (this.state === 'offline') { text = n ? '離線・' + n + ' 項待同步' : '離線'; cls = 'warn'; }
      else if (this.state === 'error') { text = '同步失敗・' + n + ' 項待同步'; cls = 'warn'; }
      else if (n) text = n + ' 項待同步';
      else if (this.s.last) { text = '已同步 ' + hhmm(this.s.last); cls = 'ok'; }
      else text = '尚未同步';
      el.textContent = text;
      el.className = 'sync ' + cls;
      el.title = this.err || '';
    },
  };
})();
