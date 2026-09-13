"""本機測試用：提供 dist-test/ 靜態檔，並用相同的 pull／push 規則模擬 Apps Script。

用法：python3 build.py --test && python3 dev/mock_server.py
資料存在 dev/mock-db.json，token 讀 dist-test/.mocktoken。
"""
import http.server
import json
import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', 'dist-test')
DB = os.path.join(HERE, 'mock-db.json')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
lock = threading.Lock()


def token():
    with open(os.path.join(ROOT, '.mocktoken'), encoding='utf-8') as f:
        return f.read().strip()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def send(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        try:
            req = json.loads(self.rfile.read(n) or b'{}')
        except ValueError:
            return self.send({'ok': False, 'error': 'bad-request'})
        if req.get('token') != token():
            return self.send({'ok': False, 'error': 'unauthorized'})
        with lock:
            db = json.load(open(DB, encoding='utf-8')) if os.path.exists(DB) else {}
            applied = 0
            if req.get('action') == 'push':
                for c in req.get('changes', []):
                    cur = db.get(c['id'])
                    if not cur or c['at'] > cur['at']:
                        db[c['id']] = {'id': c['id'], 'chap': c.get('chap', ''), 'label': c.get('label', ''),
                                       'v': c.get('v', ''), 'by': req.get('who', ''), 'at': c['at']}
                        applied += 1
                with open(DB, 'w', encoding='utf-8') as f:
                    json.dump(db, f, ensure_ascii=False, indent=1)
            elif req.get('action') != 'pull':
                return self.send({'ok': False, 'error': 'unknown-action'})
            rows = [{'id': r['id'], 'v': r['v'], 'by': r['by'], 'at': r['at']} for r in db.values()]
        self.send({'ok': True, 'applied': applied, 'rows': rows})


if __name__ == '__main__':
    print(f'測試伺服器：http://127.0.0.1:{PORT}/')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
