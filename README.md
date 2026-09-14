# 家庭旅行說明書（加密網站）

用 `manual/` 原稿產生的互動說明書。整個網頁用家庭密碼加密後放在 GitHub Pages；打勾與填寫的內容先存在各自的手機，有網路時同步到 Google 試算表，兩個人看到同一份。

## 這個 repo 放了什麼

| 路徑 | 內容 | 會上傳 GitHub |
|---|---|---|
| `docs/` | 加密後的網站（`index.html`、離線快取 `sw.js`） | ✅ 只有加密後的內容 |
| `build.py`、`encrypt.js`、`web/` | 產生網站的程式 | ✅ |
| `apps-script/Code.gs` | 同步後端，貼到 Google Apps Script | ✅ |
| `local.config.json` | 原稿路徑、同步網址、加密用 salt、標題與旅行日期（`start_date`／`end_date`，給「今天」按鈕用） | ❌（`.gitignore`） |
| 原稿 `manual/*.md`、舊手冊、PDF | 在 repo 外面，不會被加進來 | ❌ |

家庭密碼**不會**存在任何檔案裡。

## 第一次設定（大約 15 分鐘）

### 1. 產生網站

```sh
python3 build.py
```

輸入兩次家庭密碼（建議至少 10 個字元，用一句好記的長句；太短只會警告，不會擋）。完成後會產生 `apps-script/Code.generated.gs`，下一步要用。

> 網站是公開的，任何人都能下載加密檔回去猜密碼，所以密碼不要太短，也不要用生日、電話。

### 2. 設定 Google 試算表與 Apps Script

1. 打開同步用的試算表「旅行說明書｜同步資料」
2. 上方選單 **擴充功能 → Apps Script**
3. 把 `apps-script/Code.generated.gs` 的內容整份貼上，取代原本的程式碼，按儲存
4. 右上 **部署 → 新增部署作業 → 選取類型：網頁應用程式**
   - 執行身分：**我**
   - 誰可以存取：**所有人**
5. 按「部署」，第一次會要求授權，照畫面允許
6. 複製「網頁應用程式網址」（`/exec` 結尾）

> 「所有人」只代表網址打得開；程式裡只放了同步密鑰的雜湊值，沒有家庭密碼就讀不到也寫不進試算表。

### 3. 接上同步，再產生一次

把網址貼到 `local.config.json` 的 `sync_url`，再跑一次：

```sh
python3 build.py
```

### 4. 放上 GitHub Pages

1. 在 GitHub 建一個新的 repo（Public），不要勾選自動建立 README
2. 在這個資料夾執行（把網址換成你的 repo）：

```sh
git init && git add . && git commit -m "家庭旅行說明書" && git branch -M main && git remote add origin https://github.com/你的帳號/你的repo.git && git push -u origin main
```

3. repo 的 **Settings → Pages → Build and deployment**
   - Source：Deploy from a branch
   - Branch：`main`，資料夾 `/docs`
4. 等一兩分鐘，網址會是 `https://你的帳號.github.io/你的repo/`

### 5. 手機上使用

1. 用 Safari 或 Chrome 打開網址，輸入家庭密碼
2. 勾選「在這台裝置記住」，下次就不用再輸入
3. 分享選單 → **加入主畫面**，之後像 App 一樣打開；沒網路也能看
4. 第一次會問「這台裝置是誰在用」，填的名字會記在試算表的「修改者」欄

## 之後要改內容

1. 改 `manual/` 原稿（新增勾選項不用自己寫 ID）
2. 補 ID 並重新產生：

```sh
python3 build.py --assign-ids && python3 build.py
```

3. 上傳：

```sh
git add docs && git commit -m "更新說明書" && git push
```

已經勾選、填寫的內容不會不見：資料是用固定 ID 對應的，只要原稿行尾的 `{#…}` 沒被改掉就好。

## 本機測試

```sh
python3 build.py --test && python3 dev/mock_server.py
```

打開 http://127.0.0.1:8766/ ，測試密碼是 `test-only-password`，同步資料會存在 `dev/mock-db.json`。

## 常見問題

- **忘記或要換家庭密碼**：用新密碼跑 `python3 build.py`（會問你是否確定要換），把新產生的 `apps-script/Code.generated.gs` 整份貼到 Apps Script、存檔，再到 **部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署**。這樣部署網址不會變，不用改 `sync_url`。試算表裡的資料不受影響。
- **同步失敗**：工具列會顯示「同步失敗・N 項待同步」，資料還在手機上，下次有網路會自動補傳。持續失敗時，確認 Apps Script 貼的是最新的 `Code.generated.gs`、部署網址是否正確。
- **兩個人同時改同一欄**：以最後修改的為準。
