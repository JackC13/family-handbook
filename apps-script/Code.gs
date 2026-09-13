/**
 * 家庭旅行說明書：同步後端（Google Apps Script，綁在同步用的試算表上）
 *
 * 網頁把勾選與填寫的內容 POST 到這裡，存在試算表的第一個工作表：
 *   id ｜ 章節 ｜ 項目 ｜ 值 ｜ 修改者 ｜ 修改時間
 * 同一個 id 以「修改時間較新」的為準。
 *
 * 這份是範本。請貼 build.py 產生的 apps-script/Code.generated.gs，
 * 裡面已經填好同步密鑰的 SHA-256 雜湊值（不是密鑰本身）。
 *
 * 部署：部署 → 新增部署作業 → 類型選「網頁應用程式」
 *       執行身分：我　／　誰可以存取：所有人
 * 部署後的網址（/exec 結尾）貼到 local.config.json 的 sync_url。
 */

var HEADERS = ['id', '章節', '項目', '值', '修改者', '修改時間'];
var TOKEN_SHA256 = '{{TOKEN_SHA256}}';

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad-request' });
  }
  if (!authorized_(req.token)) return json_({ ok: false, error: 'unauthorized' });

  var sheet = sheet_();
  if (req.action === 'pull') return json_({ ok: true, rows: read_(sheet) });
  if (req.action === 'push') {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var applied = upsert_(sheet, req.changes || [], String(req.who || ''));
      return json_({ ok: true, applied: applied, rows: read_(sheet) });
    } finally {
      lock.releaseLock();
    }
  }
  return json_({ ok: false, error: 'unknown-action' });
}

// 用瀏覽器打開部署網址時會看到 ok，方便確認有部署成功
function doGet() {
  return ContentService.createTextOutput('ok');
}

// 只比對雜湊值：就算有人看到這份程式碼，也拿不到可以通過驗證的密鑰
function authorized_(token) {
  if (!token || TOKEN_SHA256.indexOf('{{') === 0) return false;
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8);
  var hex = digest.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  return hex === TOKEN_SHA256;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var head = sh.getRange(1, 1, 1, HEADERS.length);
  if (head.getValues()[0].join('|') !== HEADERS.join('|')) {
    head.setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  // 前五欄一律當純文字，避免「2-2」、「1/16」被自動轉成日期
  sh.getRange('A:E').setNumberFormat('@');
  return sh;
}

function time_(v) {
  return v instanceof Date ? v.getTime() : Number(v) || 0;
}

function read_(sh) {
  var n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, HEADERS.length).getValues()
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) { return { id: String(r[0]), v: String(r[3]), by: String(r[4]), at: time_(r[5]) }; });
}

function upsert_(sh, changes, who) {
  var n = sh.getLastRow();
  var index = {};
  if (n >= 2) {
    sh.getRange(2, 1, n - 1, HEADERS.length).getValues().forEach(function (r, i) {
      if (r[0] !== '') index[String(r[0])] = { row: i + 2, at: time_(r[5]) };
    });
  }
  var applied = 0;
  changes.forEach(function (c) {
    if (!c || !c.id) return;
    var at = Number(c.at) || Date.now();
    var cur = index[c.id];
    if (cur && cur.at >= at) return;
    var row = [String(c.id), text_(c.chap), text_(c.label), text_(c.v), text_(who), new Date(at)];
    if (cur) {
      sh.getRange(cur.row, 1, 1, row.length).setValues([row]);
      cur.at = at;
    } else {
      sh.appendRow(row);
      index[c.id] = { row: sh.getLastRow(), at: at };
    }
    applied++;
  });
  return applied;
}

// 以 = + - @ 開頭的文字會被試算表當成公式，前面加 ' 讓它保持純文字
function text_(v) {
  v = String(v == null ? '' : v);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}
