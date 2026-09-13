// 讀 stdin 的內容，用 TRIP_PASSWORD 與 TRIP_SALT（base64）做 AES-256-GCM 加密。
// 輸出 JSON：iter、salt、iv、ct（密文＋驗證碼，base64），以及同步用的 token。
// 網頁端用 WebCrypto 以相同參數解密（web/app.js）。
const crypto = require('crypto');

const ITER = 310000;
const TOKEN_SALT = 'trip-sync-v1';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const password = process.env.TRIP_PASSWORD;
  const salt = Buffer.from(process.env.TRIP_SALT || '', 'base64');
  if (!password || salt.length < 16) {
    process.stderr.write('缺少 TRIP_PASSWORD 或 TRIP_SALT\n');
    process.exit(1);
  }
  const key = crypto.pbkdf2Sync(password, salt, ITER, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.concat(chunks)), cipher.final(), cipher.getAuthTag()]);
  const token = crypto.pbkdf2Sync(password, TOKEN_SALT, ITER, 32, 'sha256').toString('hex');
  process.stdout.write(JSON.stringify({
    iter: ITER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    token,
  }));
});
