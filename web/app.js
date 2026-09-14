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
  function pad(n) { return ('0' + n).slice(-2); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // 搜尋時一個區塊算一筆：標題、段落、勾選項、表格列、提醒…；已經填的答案也搜得到
  var BLOCKS = ['h2', 'h3', 'p', '.task', 'tr', '.note', '.pb', '.meta', '.goal']
    .map(function (s) { return '#app section.chap ' + s; }).join(',');
  function textOf(el) {
    var t = '';
    (function walk(n) {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'SELECT') { t += ' ' + n.value + ' '; return; }
      if (n.tagName === 'INPUT') { if (n.type === 'text' && n.value) t += ' ' + n.value + ' '; return; }
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
      if (!/^(B|STRONG|EM|I|MARK|A)$/.test(n.tagName)) t += ' ';
    })(el);
    return t.replace(/\s+/g, ' ').trim();
  }

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
      this.nav(data);
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
        if (el.matches('input[type="checkbox"][data-id], select[data-id]')) self.local(el, false);
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
      if (el.type === 'checkbox') { el.checked = (v === '✓' || v === '1'); return; }
      // 原稿改過選項後，已經選過的舊答案還是要看得到
      if (el.tagName === 'SELECT' && v && !Array.prototype.some.call(el.options, function (o) { return o.value === v; })) el.add(new Option(v, v));
      if (el.value !== v) el.value = v;
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

    // ---------- 導覽：下方導覽列、目錄與搜尋、今天、上一章／下一章 ----------

    nav: function (data) {
      var self = this, sheet = $('#sheet');
      if (!sheet) return;
      this.plan = (data.config && data.config.today) || null;
      this.chaps = $$('#app section.chap').map(function (s) {
        var h = $('h2', s), cid = $('.cid', h);
        return { id: s.getAttribute('data-chap'), el: s, title: h.textContent.slice(cid ? cid.textContent.length : 0).trim() };
      });
      this.chaps.forEach(function (c, i) {
        var p = self.chaps[i - 1], n = self.chaps[i + 1], el = document.createElement('nav');
        el.className = 'chnav';
        el.setAttribute('aria-label', '上一章與下一章');
        el.innerHTML = (p ? '<a class="pv" href="#c' + p.id + '">← ' + p.id + ' ' + esc(p.title) + '</a>' : '')
          + (n ? '<a class="nx" href="#c' + n.id + '">' + n.id + ' ' + esc(n.title) + ' →</a>' : '');
        c.el.appendChild(el);
      });
      if (!this.plan) $('#nav-today').hidden = true;
      // 目錄：一鍵回到頁首的目錄，剛剛讀到的那一章會標出來
      $('#nav-toc').addEventListener('click', function () {
        var t = $('#toc');
        if (t) { t.scrollIntoView({ block: 'start' }); self.track(); }
      });
      $('#nav-find').addEventListener('click', function () { self.openSheet(true); });
      $('#nav-today').addEventListener('click', function () { self.today(); });
      $('#sheet-x').addEventListener('click', function () { self.closeSheet(); });
      $('#q').addEventListener('input', function () { self.search(this.value); });
      sheet.addEventListener('click', function (ev) {
        if (ev.target === sheet) { self.closeSheet(); return; }
        var a = ev.target.closest('a');
        if (!a) return;
        ev.preventDefault();
        var k = a.getAttribute('data-k');
        var el = k !== null ? self.hits[+k].el : document.getElementById(a.getAttribute('href').slice(1));
        self.closeSheet();
        if (el) self.go(el);
      });
      document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !sheet.hidden) self.closeSheet(); });
      var ticking = false;
      window.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () { ticking = false; self.track(); });
      }, { passive: true });
      this.track();
    },

    // 目前讀到哪一章：標題已經捲到工具列下方的最後一章
    track: function () {
      var cur = null;
      for (var i = 0; i < this.chaps.length; i++) {
        if (this.chaps[i].el.getBoundingClientRect().top <= 110) cur = this.chaps[i];
        else break;
      }
      if (cur === this.cur) return;
      this.cur = cur;
      if (!cur) return;
      // 捲回頁首時保留「剛剛讀到哪一章」，目錄和導覽列都還看得到
      this.lastChap = cur;
      $('#nav-cur').textContent = cur.id;
      $$('.toc li.cur').forEach(function (li) { li.classList.remove('cur'); });
      var a = $('.toc a[href="#c' + cur.id + '"]');
      if (a) a.parentNode.classList.add('cur');
    },

    go: function (el) {
      if (!el.offsetParent) {
        // 被「只看未完成」藏起來的項目，先恢復顯示全部
        document.body.classList.remove('only-todo');
        $('#btn-todo').setAttribute('aria-pressed', 'false');
      }
      var chap = el.matches('section');
      el.scrollIntoView({ block: chap ? 'start' : 'center' });
      this.track();
      if (!chap) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      }
    },

    openSheet: function (find) {
      var q = $('#q');
      $('#sheet').hidden = false;
      document.documentElement.classList.add('noscroll');
      this.search(q.value);
      if (find) q.focus();
      else { var li = $('#sheet-body li.cur'); if (li) li.scrollIntoView({ block: 'center' }); }
    },

    closeSheet: function () {
      $('#sheet').hidden = true;
      document.documentElement.classList.remove('noscroll');
      $('#q').blur();
    },

    search: function (q) {
      var self = this, body = $('#sheet-body');
      q = q.trim();
      if (!q) {
        var h = '', open = false;
        $$('#app h1.part, #app section.chap').forEach(function (el) {
          if (el.tagName === 'H1') {
            h += (open ? '</ol></div>' : '') + '<div class="tp"><b>' + esc(el.textContent) + '</b><ol>';
            open = true;
            return;
          }
          var id = el.getAttribute('data-chap'), c = self.chaps.filter(function (x) { return x.id === id; })[0];
          h += '<li' + (self.lastChap && self.lastChap.id === id ? ' class="cur"' : '') + '><a href="#c' + id + '"><span class="cid">' + id
            + '</span>' + esc(c ? c.title : '') + '</a><span class="cp" data-cp="' + id + '"></span></li>';
        });
        body.innerHTML = h + (open ? '</ol></div>' : '');
        this.refresh();
        return;
      }
      var lq = q.toLowerCase(), hits = [];
      $$(BLOCKS).some(function (el) {
        var t = textOf(el), i = t.toLowerCase().indexOf(lq);
        if (i >= 0) hits.push({ el: el, t: t, i: i, c: el.closest('section.chap').getAttribute('data-chap') });
        return hits.length >= 60;
      });
      this.hits = hits;
      body.innerHTML = hits.length
        ? hits.map(function (x, k) {
          var a = Math.max(0, x.i - 18), b = x.i + q.length;
          return '<a class="hit" href="#" data-k="' + k + '"><span class="cid">' + x.c + '</span>' + (a ? '…' : '')
            + esc(x.t.slice(a, x.i)) + '<mark>' + esc(x.t.slice(x.i, b)) + '</mark>' + esc(x.t.slice(b, b + 44))
            + (b + 44 < x.t.length ? '…' : '') + '</a>';
        }).join('') + (hits.length >= 60 ? '<p class="nohit">只列出前 60 筆，換個更精確的字試試。</p>' : '')
        : '<p class="nohit">找不到「' + esc(q) + '」。</p>';
    },

    today: function () {
      var p = this.plan, n = new Date(), msg;
      var key = n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate());
      var id = p.days[key];
      if (id) msg = '今天 ' + (n.getMonth() + 1) + '/' + n.getDate();
      else if (key < p.start) {
        var d = Math.round((Date.parse(p.start + 'T00:00:00') - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 864e5);
        var c = p.countdown.filter(function (x) { return x[0] >= d; })[0] || p.countdown[p.countdown.length - 1];
        id = c && c[1];
        msg = '出發前 ' + d + ' 天';
      } else { this.toast('旅程已經結束'); return; }
      var ch = this.chaps.filter(function (x) { return x.id === id; })[0];
      if (!ch) return;
      this.toast(msg + ' → ' + ch.id + ' ' + ch.title);
      this.go(ch.el);
    },

    toast: function (t) {
      var el = $('#toast');
      el.textContent = t;
      el.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(function () { el.hidden = true; }, 3500);
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
