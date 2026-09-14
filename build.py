#!/usr/bin/env python3
"""把 manual/*.md 產生成加密的家庭旅行說明書網站。

  python3 build.py                正式版：輸入家庭密碼，輸出到 docs/（放上 GitHub Pages）
  python3 build.py --assign-ids   幫原稿裡還沒有 ID 的勾選項與填寫欄補上固定 ID
  python3 build.py --test         測試版：輸出到 dist-test/，同步到本機測試伺服器
"""
import argparse
import base64
import getpass
import hashlib
import html
import io
import json
import os
import re
import secrets
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
CFG = ROOT / 'local.config.json'
ID_RE = re.compile(r'\s*\{#([A-Za-z0-9-]+)\}\s*$')
MODE = {'開車': 'driving', '步行': 'walking', '大眾運輸': 'transit'}
TEST_SYNC_URL = 'http://127.0.0.1:8766/api'


# ---------- 設定 ----------

def rel(p):
    p = Path(p)
    return p if p.is_absolute() else (ROOT / p).resolve()


def load_config():
    if not CFG.exists():
        sys.exit('找不到 local.config.json，請先複製 local.config.example.json 並填好路徑。')
    cfg = json.loads(CFG.read_text(encoding='utf-8'))
    if not cfg.get('enc_salt'):
        cfg['enc_salt'] = base64.b64encode(secrets.token_bytes(16)).decode()
        save_config(cfg)
    return cfg


def save_config(cfg):
    CFG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def load_sources(cfg):
    src = {}
    add = rel(cfg['additions_py'])
    for k, label, url in re.findall(r"'([A-Z0-9-]+)':\('([^']+)','([^']+)'\)", add.read_text(encoding='utf-8')):
        src[k] = (label, url)
    links = rel(cfg['manual_dir']) / 'links.json'
    if links.exists():
        src.update({k: tuple(v) for k, v in json.loads(links.read_text(encoding='utf-8')).items()})
    return src


def shrink_jpeg(p):
    """把照片縮到最長邊 900px 的 JPEG；優先用 Pillow，沒有的話用 macOS 內建的 sips。"""
    try:
        from PIL import Image
        im = Image.open(p).convert('RGB')
        im.thumbnail((900, 900))
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=72, optimize=True)
        return buf.getvalue()
    except ImportError:
        import shutil
        import tempfile
        if not shutil.which('sips'):
            return None
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'photo.jpg'
            r = subprocess.run(['sips', '-Z', '900', '-s', 'format', 'jpeg', '-s', 'formatOptions', '72',
                                str(p), '--out', str(out)], capture_output=True)
            return out.read_bytes() if r.returncode == 0 and out.exists() else None


def load_photos(cfg):
    pj = rel(cfg.get('photos_json', ''))
    if not pj.is_file():
        return {}
    base = pj.parent.parent
    out = {}
    for key, v in json.loads(pj.read_text(encoding='utf-8')).items():
        p = Path(v.get('path', ''))
        if not p.is_absolute():
            p = base / p
        data = shrink_jpeg(p) if p.is_file() else None
        if not data:
            continue
        out[key] = dict(data=base64.b64encode(data).decode(), author=str(v.get('author', '')),
                        license=str(v.get('license', '')), url=str(v.get('url', '')))
    return out


# ---------- 固定 ID ----------

def split_id(s):
    m = ID_RE.search(s)
    return (s[:m.start()].rstrip(), m.group(1)) if m else (s.rstrip(), None)


def assign_ids(manual_dir):
    """新的勾選項編號用該章現有最大號碼 +1，刪掉的號碼不會被重複使用。"""
    total = 0
    for f in sorted(manual_dir.glob('0*.md')):
        text = f.read_text(encoding='utf-8')
        existing = set(re.findall(r'\{#([A-Za-z0-9-]+)\}', text))

        def next_id(prefix):
            nums = [int(m.group(1)) for x in existing for m in [re.fullmatch(re.escape(prefix) + r'(\d+)', x)] if m]
            new = f'{prefix}{max(nums, default=0) + 1}'
            existing.add(new)
            return new

        out, chap, task, added = [], None, None, 0
        for line in text.split('\n'):
            m = re.match(r'## (\d-\d+)｜', line)
            if m:
                chap, task = m.group(1), None
            if line.startswith('- [ ]'):
                body, tid = split_id(line)
                if not tid:
                    tid = next_id(f'{chap}-t')
                    line = f'{body} {{#{tid}}}'
                    added += 1
                task = tid
            elif line.startswith(('  - 填寫：', '  - 選擇：')) and task:
                body, fid = split_id(line)
                if not fid:
                    fid = next_id(f'{task}-f')
                    line = f'{body} {{#{fid}}}'
                    added += 1
            elif not line.startswith('  - '):
                task = None
            out.append(line)
        if added:
            f.write_text('\n'.join(out), encoding='utf-8')
        print(f'{f.name}：補上 {added} 個 ID')
        total += added
    print(f'共補上 {total} 個 ID')


# ---------- 產生網頁 ----------

def e(s):
    return html.escape(str(s), quote=True)


def inline(t):
    t = e(t)
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    return (t.replace('〔待確認〕', '<span class="tag ask">待確認</span>')
             .replace('〔建議補充〕', '<span class="tag add">建議補充</span>'))


def plain(t):
    return re.sub(r'〔[^〕]*〕', '', str(t).replace('**', '')).strip()


class Renderer:
    def __init__(self, src, photos):
        self.src, self.photos = src, photos
        self.out, self.fields, self.toc, self.errors = [], {}, [], []
        self.chap, self.chap_open, self.box, self.sec, self.tb = None, False, None, None, 0

    def emit(self, h):
        self.out.append(h)

    def end_box(self):
        if self.box:
            self.emit('</div>')
            self.box = None

    def open_box(self, kind):
        if self.box != kind:
            self.end_box()
            self.emit(f'<div class="{kind}">')
            self.box = kind

    def close_chap(self):
        self.end_box()
        if self.chap_open:
            self.emit('</section>')
            self.chap_open = False

    def field(self, fid, label, kind='text'):
        if fid in self.fields:
            self.errors.append(f'ID 重複：{fid}')
        self.fields[fid] = {'chap': self.chap or '', 'label': label[:80], 'kind': kind}

    def render(self, files):
        for f in files:
            lines = f.read_text(encoding='utf-8').split('\n')
            i = 0
            while i < len(lines):
                i = self.line(lines, i, f.name)
            self.close_chap()
        return self.page()

    def line(self, L, i, fname):
        s = L[i].strip()
        if not s:
            return i + 1
        if s.startswith('|'):
            rows = []
            while i < len(L) and L[i].strip().startswith('|'):
                cells = [c.strip() for c in L[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?', c) for c in cells):
                    rows.append(cells)
                i += 1
            self.table(rows)
            return i
        if s.startswith('# '):
            self.close_chap()
            self.toc.append([s[2:], []])
            self.emit(f'<h1 class="part" id="part-{len(self.toc)}">{inline(s[2:])}</h1>')
        elif s.startswith('## '):
            self.close_chap()
            m = re.match(r'## (\d-\d+)｜(.+)', s)
            if not m:
                self.errors.append(f'{fname}：章標題格式不對：{s}')
                return i + 1
            self.chap, title, self.tb = m.group(1), m.group(2), 0
            self.toc[-1][1].append((self.chap, title))
            self.emit(f'<section class="chap" id="c{self.chap}" data-chap="{self.chap}">'
                      f'<h2><span class="cid">{self.chap}</span>{inline(title)}</h2>')
            self.chap_open = True
        elif s.startswith('### '):
            self.end_box()
            t = s[4:]
            self.sec = t.split('｜')[0]
            cls = {'A': 'sa', 'B': 'sb', 'C': 'sc', '旁欄': 'side', '表格': 'st'}.get(self.sec, '')
            self.emit(f'<h3 class="{cls}">{inline(t)}</h3>')
            if self.sec == 'C':
                self.open_box('planb')
        elif s.startswith('資訊｜'):
            self.end_box()
            self.emit('<div class="meta">' + ''.join(f'<span>{inline(x)}</span>' for x in s[3:].split('｜')) + '</div>')
        elif s.startswith('> 目標：'):
            self.end_box()
            self.emit(f'<div class="goal"><b>這一章做完的樣子</b>{inline(s[5:])}</div>')
        elif s.startswith('- [ ]'):
            return self.task(L, i, fname)
        elif s.startswith('- ') and self.box == 'planb':
            self.emit(f'<div class="pb">{inline(s[2:])}</div>')
        elif s.startswith('提醒｜'):
            self.end_box()
            self.emit(f'<div class="note">{inline(s[3:])}</div>')
        elif s.startswith('連結：'):
            self.end_box()
            self.emit('<div class="links">' + ''.join(self.link(k) for k in s[3:].split('｜')) + '</div>')
        elif s.startswith('地圖：'):
            self.end_box()
            self.emit(f'<div class="map">{self.maplink(s[3:])}</div>')
        elif s.startswith('照片：'):
            self.photo(s[3:].strip())
        elif s.startswith('*來源：'):
            self.end_box()
            self.emit(f'<p class="from">{e(s.strip("*"))}</p>')
        else:
            self.end_box()
            self.emit(f'<p>{inline(s)}</p>')
        return i + 1

    def task(self, L, i, fname):
        self.open_box('card')
        text, tid = split_id(L[i].strip()[5:].strip())
        if not tid:
            self.errors.append(f'{fname}：勾選項沒有 ID（先跑 python3 build.py --assign-ids）：{text[:30]}')
            tid = f'missing-{len(self.fields)}'
        label = plain(text)
        self.field(tid, label, 'check')
        subs, fills = [], None
        i += 1
        while i < len(L) and L[i].startswith('  - '):
            sub = L[i].strip()[2:]
            if sub.startswith(('填寫：', '選擇：')):
                # 連續的填寫與選擇排在同一個區塊
                if fills is None:
                    fills = []
                    subs.append(fills)
                # 試算表的「項目」欄只放粗體標題，才看得出是哪一題
                short = plain(m.group(1)) if (m := re.match(r'\*\*(.+?)\*\*', text)) else label
                fills.extend(self.fill_rows(sub, short, fname))
                i += 1
                continue
            fills = None
            if sub.startswith('英文：'):
                subs.append(f'<div class="en">{e(sub[3:])}</div>')
            elif sub.startswith('預約：'):
                subs.append(self.link(sub[3:].strip(), 'book'))
            else:
                subs.append(f'<small>{inline(sub)}</small>')
            i += 1
        subs = ''.join(f'<div class="fill">{"".join(x)}</div>' if isinstance(x, list) else x for x in subs)
        self.emit(f'<div class="task"><input type="checkbox" id="{tid}" data-id="{tid}">'
                  f'<div class="tx"><label for="{tid}">{inline(text)}</label>{subs}</div></div>')
        return i

    def fill_rows(self, sub, label, fname):
        """填寫：甲／乙 → 每段一個輸入框；選擇：標籤｜甲／乙 → 一個下拉選單。"""
        kind = sub[:2]
        body, fid = split_id(sub[3:])
        if not fid:
            self.errors.append(f'{fname}：{kind}欄沒有 ID（先跑 python3 build.py --assign-ids）：{body[:30]}')
            fid = f'missing-{len(self.fields)}'
        if kind == '選擇':
            name, _, opts = body.partition('｜')
            name, opts = name.strip(), [x.strip() for x in opts.split('／') if x.strip()]
            if not opts:
                self.errors.append(f'{fname}：選擇沒有選項（格式：選擇：標籤｜甲／乙）：{body[:30]}')
            self.field(fid, f'{label[:40]}｜{name}', 'choice')
            return [f'<label class="fi"><span>{e(name)}</span><select data-id="{fid}">'
                    '<option value="">還沒決定</option>' + ''.join(f'<option>{e(o)}</option>' for o in opts)
                    + '</select></label>']
        rows = []
        for k, seg in enumerate([x.strip() for x in body.split('／') if x.strip()], 1):
            fk = f'{fid}-{k}'
            self.field(fk, f'{label[:40]}｜{seg}')
            rows.append(f'<label class="fi"><span>{e(seg)}</span><input type="text" data-id="{fk}" autocomplete="off"></label>')
        return rows

    def link(self, key, cls='lk'):
        key = key.strip()
        if key not in self.src:
            self.errors.append(f'連結代號不存在：{key}')
            return ''
        label, url = self.src[key]
        return f'<a class="{cls}" href="{e(url)}" target="_blank" rel="noopener">{e(label)}</a>'

    def maplink(self, s):
        m = re.match(r'(.+?)\s*→\s*(.+?)（(開車|步行|大眾運輸)）$', s)
        if m:
            url = (f'https://www.google.com/maps/dir/?api=1&origin={quote(m.group(1))}'
                   f'&destination={quote(m.group(2))}&travelmode={MODE[m.group(3)]}')
            return f'<a href="{e(url)}" target="_blank" rel="noopener">{e(m.group(1))} → {e(m.group(2))}（{m.group(3)}）</a>'
        return f'<a href="https://www.google.com/maps/search/?api=1&amp;query={quote(s)}" target="_blank" rel="noopener">{e(s)}</a>'

    def photo(self, key):
        p = self.photos.get(key)
        if not p:
            return
        credit = ' · '.join(x for x in [p['author'], p['license']] if x) or '照片來源'
        cap = f'<a href="{e(p["url"])}" target="_blank" rel="noopener">{e(credit)}</a>' if p['url'] else e(credit)
        self.emit(f'<figure class="photo"><img src="data:image/jpeg;base64,{p["data"]}" alt="" loading="lazy">'
                  f'<figcaption>照片：{cap}</figcaption></figure>')

    def cell(self, c, fid, label):
        if c.strip() == '':
            self.field(fid, label)
            return f'<input type="text" data-id="{e(fid)}" aria-label="{e(label)}" autocomplete="off">'
        if '＿＿' in c:
            parts = re.split(r'＿{2,}', c)
            h = inline(parts[0])
            for k, rest in enumerate(parts[1:], 1):
                fk = f'{fid}-{k}'
                self.field(fk, label)
                h += f'<input type="text" class="inl" data-id="{e(fk)}" aria-label="{e(label)}" autocomplete="off">' + inline(rest)
            return h
        return inline(c)

    def table(self, rows):
        self.end_box()
        if not rows:
            return
        self.tb += 1
        head, body = rows[0], rows[1:]
        h = ('<div class="tbl' + (' b' if self.sec == 'B' else '') + '"><table><thead><tr>'
             + ''.join(f'<th>{inline(c)}</th>' for c in head) + '</tr></thead><tbody>')
        for r in body:
            key = re.sub(r'[\s|｜/／()（）:：·,，、]+', '', plain(r[0]))[:24] or 'row'
            h += '<tr>'
            for ci, c in enumerate(r):
                col = plain(head[ci]) if ci < len(head) else str(ci)
                h += f'<td>{self.cell(c, f"{self.chap}-tb{self.tb}-{key}-{ci}", f"{plain(r[0])}｜{col}")}</td>'
            h += '</tr>'
        self.emit(h + '</tbody></table></div>')

    def page(self):
        toc = '<nav class="toc" id="toc"><h2>目錄</h2>' + ''.join(
            f'<div class="tp"><a href="#part-{pi}">{inline(t)}</a><ol>' + ''.join(
                f'<li><a href="#c{cid}"><span class="cid">{cid}</span>{inline(ct)}</a><span class="cp" data-cp="{cid}"></span></li>'
                for cid, ct in ch) + '</ol></div>'
            for pi, (t, ch) in enumerate(self.toc, 1)) + '</nav>'
        n_check = sum(1 for v in self.fields.values() if v['kind'] == 'check')
        bar = ('<header class="bar"><div class="bar-in"><a class="brand" href="#top">旅行說明書</a>'
               '<span class="prog" id="prog"></span><span class="sync" id="sync" role="status"></span>'
               '<button type="button" id="btn-todo" aria-pressed="false">只看未完成</button>'
               '<details class="menu"><summary aria-label="更多選項">⋯</summary><div>'
               '<button type="button" id="btn-sync">立即同步</button>'
               '<button type="button" id="btn-who">設定使用者名稱</button>'
               '<button type="button" id="btn-lock">鎖定這台裝置</button></div></details></div></header>')
        intro = (f'<div class="wrap" id="top"><p class="eyebrow">{html.escape(self.subtitle)}</p>'
                 f'<h1 class="title">{html.escape(self.title)}</h1>'
                 f'<p class="legend">照時間排好的說明書，到了哪一天就看哪一章。打勾和填寫會先存在這台裝置，'
                 f'有網路時自動同步到共用的試算表。共 {n_check} 個勾選項。</p>')
        return bar + intro + toc + ''.join(self.out) + '</div>' + self.dock()

    def dock(self):
        """手機下方的導覽列、目錄與搜尋面板；行為在 web/app.js 的 nav()。"""
        ask = next((c for _, ch in self.toc for c, t in ch if '待確認' in t), None)
        sos = next((ch[0][0] for t, ch in self.toc if '緊急' in t and ch), None)
        return ('<nav class="dock" aria-label="快速導覽">'
                '<button type="button" id="nav-toc"><i aria-hidden="true">📖</i>目錄<small id="nav-cur"></small></button>'
                '<button type="button" id="nav-find"><i aria-hidden="true">🔍</i>搜尋</button>'
                '<button type="button" id="nav-today"><i aria-hidden="true">📅</i>今天</button>'
                + (f'<a href="#c{ask}"><i aria-hidden="true">❓</i>待確認</a>' if ask else '')
                + (f'<a href="#c{sos}"><i aria-hidden="true">🆘</i>緊急</a>' if sos else '')
                + '</nav>'
                '<div class="sheet" id="sheet" hidden><div class="sheet-in" role="dialog" aria-modal="true" aria-label="目錄與搜尋">'
                '<div class="sheet-hd"><input type="search" id="q" placeholder="搜尋地址、預約號、景點…" aria-label="搜尋說明書"'
                ' autocomplete="off" enterkeyhint="search"><button type="button" id="sheet-x">關閉</button></div>'
                '<div id="sheet-body"></div></div></div>'
                '<div class="toast" id="toast" role="status" hidden></div>')


def today_plan(toc, start, end):
    """「今天」按鈕用的對照表：出發前對到倒數章節，旅途中每一天對到一章。
    放在加密內容裡，所以日期不會出現在公開的原始碼。"""
    if not (start and end):
        return None
    s, t = date.fromisoformat(start), date.fromisoformat(end)
    chaps = [(cid, plain(title)) for _, ch in toc for cid, title in ch]
    countdown, dated = [], {}
    for order, (cid, title) in enumerate(chaps):
        m = re.search(r'出發前\s*(?:\d+\s*[–-]\s*)?(\d+)\s*(週|小時)', title)
        if m:
            n = int(m.group(1))
            # 「出發前 N 週」從第 N 週開始看；同一天數有兩章時取後面那章（例如 4–6 週排在 6 週之後）
            countdown.append((n * 7 if m.group(2) == '週' else max(1, -(-n // 24)), -order, cid))
        m = re.match(r'(\d{1,2})/(\d{1,2})（', title)
        if m:
            mo, dd = int(m.group(1)), int(m.group(2))
            dated[date(s.year if mo >= s.month else s.year + 1, mo, dd)] = cid
    # 沒有專屬章節的日子（長住期間）：抵達後一週內看「第一週」，週末看「週末」，其他看「平日」
    first_week = next((c for c, x in chaps if '第一週' in x), None)
    weekend = next((c for c, x in chaps if x.startswith('週末')), None)
    weekday = next((c for c, x in chaps if x.startswith('平日')), None)
    days, last, d = {}, None, s
    while d <= t:
        if d in dated:
            last, pick = d, dated[d]
        elif last and first_week and (d - last).days <= 7:
            pick = first_week
        elif d.weekday() >= 5 and weekend:
            pick = weekend
        else:
            pick = weekday or (dated[last] if last else None)
        if pick:
            days[d.isoformat()] = pick
        d += timedelta(days=1)
    return {'start': start, 'countdown': [[n, c] for n, _, c in sorted(countdown)], 'days': days}


# ---------- 加密與輸出 ----------

def encrypt(payload, password, salt_b64):
    env = dict(os.environ, TRIP_PASSWORD=password, TRIP_SALT=salt_b64)
    r = subprocess.run(['node', str(ROOT / 'encrypt.js')], input=payload, capture_output=True, env=env)
    if r.returncode:
        sys.exit('加密失敗：' + r.stderr.decode())
    return json.loads(r.stdout)


def ask_password(cfg):
    pw = os.environ.get('FAMILY_PASSWORD') or getpass.getpass('家庭密碼：')
    if not os.environ.get('FAMILY_PASSWORD') and not cfg.get('pw_check'):
        if getpass.getpass('再輸入一次：') != pw:
            sys.exit('兩次輸入的密碼不一樣。')
    if len(pw) < 10:
        print('⚠ 密碼少於 10 個字元：網站是公開的，短密碼比較容易被離線破解。')
    return pw


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--assign-ids', action='store_true', help='幫原稿補上固定 ID')
    ap.add_argument('--test', action='store_true', help='產生本機測試版')
    a = ap.parse_args()

    cfg = load_config()
    manual = rel(cfg['manual_dir'])
    if a.assign_ids:
        assign_ids(manual)
        return

    r = Renderer(load_sources(cfg), load_photos(cfg))
    # 標題與日期放在 local.config.json：repo 是公開的，不要讓原始碼寫出目的地和出發日期
    r.title, r.subtitle = cfg.get('title') or '旅行說明書', cfg.get('subtitle', '')
    body = r.render(sorted(manual.glob('0*.md')))
    if r.errors:
        print('原稿有問題，先修正再產生：')
        for x in r.errors:
            print('  -', x)
        sys.exit(1)

    if a.test:
        out, pw, sync = ROOT / 'dist-test', os.environ.get('TEST_PASSWORD', 'test-only-password'), TEST_SYNC_URL
    else:
        out, pw, sync = ROOT / 'docs', ask_password(cfg), cfg.get('sync_url', '')

    payload = json.dumps({'title': r.title, 'html': body, 'fields': r.fields,
                          'config': {'syncUrl': sync,
                                     'today': today_plan(r.toc, cfg.get('start_date'), cfg.get('end_date'))}},
                         ensure_ascii=False).encode()
    enc = encrypt(payload, pw, cfg['enc_salt'])
    token = enc.pop('token')

    if not a.test:
        check = hashlib.sha256(token.encode()).hexdigest()[:16]
        if cfg.get('pw_check') and cfg['pw_check'] != check:
            if input('這次的密碼跟上次不同。換密碼後，每台裝置都要重新輸入，Apps Script 的 SYNC_TOKEN 也要更新。確定要換？(y/N) ').lower() != 'y':
                sys.exit('已取消。')
        cfg['pw_check'] = check
        save_config(cfg)

    web = ROOT / 'web'
    page = ((web / 'shell.html').read_text(encoding='utf-8')
            .replace('{{CSS}}', (web / 'app.css').read_text(encoding='utf-8'))
            .replace('{{APPJS}}', (web / 'app.js').read_text(encoding='utf-8'))
            .replace('{{PAYLOAD}}', json.dumps(enc)))
    out.mkdir(exist_ok=True)
    (out / 'index.html').write_text(page, encoding='utf-8')
    (out / 'sw.js').write_text((web / 'sw.js').read_text(encoding='utf-8'), encoding='utf-8')
    (out / '.nojekyll').write_text('', encoding='utf-8')

    n_check = sum(1 for v in r.fields.values() if v['kind'] == 'check')
    print(f'完成：{out / "index.html"}（{(out / "index.html").stat().st_size // 1024} KB）')
    print(f'  勾選項 {n_check}、填寫欄 {len(r.fields) - n_check}、照片 {sum(1 for x in r.out if "class=\"photo\"" in x)}')
    if a.test:
        (out / '.mocktoken').write_text(token, encoding='utf-8')
        print('  測試版密碼：' + pw)
    else:
        gs = ROOT / 'apps-script' / 'Code.generated.gs'
        digest = hashlib.sha256(token.encode()).hexdigest()
        gs.write_text((ROOT / 'apps-script' / 'Code.gs').read_text(encoding='utf-8')
                      .replace("'{{TOKEN_SHA256}}'", f"'{digest}'"), encoding='utf-8')
        print(f'\nApps Script 程式碼：{gs}')
        print('  第一次設定或換密碼時，把這份整個貼到 Apps Script 並重新部署。')
        if not sync:
            print('\n⚠ local.config.json 還沒有 sync_url，這一版只會存在各自的裝置，不會同步。')


if __name__ == '__main__':
    main()
