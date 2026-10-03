// 裏で止められても続きから取り込めること／裏のタブでも動くこと
// node test/e2e-resume.mjs
// ブラウザでの通し試験: node test/e2e.mjs
// 疑似地図からスクショ／動画を作り、アプリに読み込ませて書き出し結果を元画像と比べる。
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'www');
const tmp = path.join(process.env.TMPDIR || os.tmpdir(), 'largepic-e2e');
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const f = p.endsWith('/') ? p + 'index.html' : p;
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.text().startsWith('解析') || m.type() === 'error') console.log('CONSOLE', m.text()); });
await page.goto(url);

// 疑似地図（世界）を作り、指定位置の「スクショ」を PNG で返す関数をページに置く
await page.evaluate(() => {
  const W = 3000, H = 3000;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let s = 42; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  g.fillStyle = '#eef0e6'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 160; i++) { g.fillStyle = `hsl(${90 + r() * 120},40%,${70 + r() * 15}%)`; g.fillRect(r() * W, r() * H, 40 + r() * 300, 40 + r() * 300); }
  g.strokeStyle = '#fff'; g.lineCap = 'round';
  for (let i = 0; i < 60; i++) { g.lineWidth = 4 + r() * 12; g.beginPath(); g.moveTo(r() * W, r() * H); g.bezierCurveTo(r() * W, r() * H, r() * W, r() * H, r() * W, r() * H); g.stroke(); }
  g.fillStyle = '#334'; g.font = '22px sans-serif';
  for (let i = 0; i < 500; i++) g.fillText('地点' + i, r() * W, r() * H);
  window.__world = c;
  window.__shot = (x, y, w = 390, h = 844) => {
    const o = document.createElement('canvas'); o.width = w; o.height = h;
    const q = o.getContext('2d');
    q.drawImage(c, x, y, w, h, 0, 0, w, h);
    // 動かないUI（検索バー・タブバー）
    q.fillStyle = '#fff'; q.fillRect(0, 0, w, 100); q.fillStyle = '#888'; q.fillRect(20, 40, w - 40, 44);
    q.fillStyle = '#fafafa'; q.fillRect(0, h - 100, w, 100); q.fillStyle = '#39f'; q.fillRect(30, h - 80, 60, 50);
    return o.toDataURL('image/png');
  };
});

async function saveShot(name, x, y) {
  const d = await page.evaluate(([x, y]) => window.__shot(x, y), [x, y]);
  const f = path.join(tmp, name);
  await writeFile(f, Buffer.from(d.split(',')[1], 'base64'));
  return f;
}

async function makeVideo(name, pts) {
  const dir = path.join(tmp, name); await mkdir(dir, { recursive: true });
  for (let k = 0; k < pts.length; k++) {
    const d = await page.evaluate(([x, y]) => window.__shot(x, y), pts[k]);
    await writeFile(path.join(dir, `f${String(k).padStart(4, '0')}.png`), Buffer.from(d.split(',')[1], 'base64'));
  }
  const out = path.join(tmp, name + '.webm');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '10', '-i', path.join(dir, 'f%04d.png'), '-c:v', 'libvpx-vp9', '-b:v', '4M', '-pix_fmt', 'yuv420p', out]);
  return out;
}
async function importVideo(file) {
  await page.setInputFiles('#fileVideo', file);
  await page.waitForSelector('#dlgCrop[open]', { timeout: 20000 });
  await page.click('#dlgCrop [data-ok]');
  await page.waitForFunction(() => !document.querySelector('#dlgProgress').open, null, { timeout: 120000, polling: 500 });
}

let fail=0; const check=(c,m)=>{console.log(c?'OK ':'NG ',m); if(!c) fail++;};
const info = () => page.evaluate(() => ({ n: window.largepic.mosaic.tiles.length, bb: window.largepic.mosaic.bbox() }));
// 動画：東へ → 南へ → 西へ（キーフレームが十数個になる長さ）
const P = [];
for (let k = 0; k < 40; k++) P.push([400 + k * 18, 600]);
for (let k = 0; k < 30; k++) P.push([1100, 600 + k * 14]);
for (let k = 0; k < 40; k++) P.push([1100 - k * 18, 1000]);
const vid = await makeVideo('vidResume', P);
const jobProgress = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('largepic-jobs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const m = await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get('meta'); r.onsuccess = () => res(r.result); });
  db.close();
  return m ? { next: m.next, total: m.keys.length } : null;
});

// 1) 基準：最後まで普通に取り込んだ結果
await page.evaluate(() => window.largepic.mosaic.clear());
await importVideo(vid);
const base = await info();
console.log('基準', JSON.stringify(base));
check(base.n >= 8, `基準の取り込み (${base.n}枚)`);
check(await jobProgress() === null, '取り込みが終わったら途中経過は消える');

// 2) 裏でページが止められた（＝ページが再読み込みされた）つもりで、取り込みの途中でリロード
await page.evaluate(() => window.largepic.mosaic.clear());
await page.evaluate(() => window.largepic.store.flush());
await page.setInputFiles('#fileVideo', vid);
await page.waitForSelector('#dlgCrop[open]', { timeout: 20000 });
await page.click('#dlgCrop [data-ok]');
await page.waitForFunction(() => window.largepic.mosaic.tiles.length >= 4, null, { timeout: 120000, polling: 100 });
await page.evaluate(() => window.largepic.store.flush());
const mid = await jobProgress();
console.log('途中経過', JSON.stringify(mid), 'タイル', await info().then((x) => x.n));
check(mid && mid.next > 0 && mid.next < mid.total, `取り込みの途中経過が端末に残る (${mid && mid.next} / ${mid && mid.total})`);
await page.reload();
await page.waitForSelector('#dlgRestore[open]');
await page.click('#restoreGo');
await page.waitForSelector('#dlgResume[open]', { timeout: 30000 });
const txt = await page.evaluate(() => document.querySelector('#rsBody').textContent);
console.log(txt);
check(/途中/.test(txt), '戻ると「取り込みの続き」を再開するか尋ねられる');
await page.click('#rsGo');
await page.waitForSelector('#dlgProgress[open]', { timeout: 30000 });
await page.waitForFunction(() => !document.querySelector('#dlgProgress').open, null, { timeout: 180000, polling: 300 });
await page.waitForTimeout(500);
const resumed = await info();
console.log('再開後', JSON.stringify(resumed));
check(Math.abs(resumed.bb.w - base.bb.w) <= 30 && Math.abs(resumed.bb.h - base.bb.h) <= 30, `続きから取り込むと、最後まで通した場合と同じ大きさになる (${resumed.bb.w}×${resumed.bb.h} ≈ ${base.bb.w}×${base.bb.h})`);
check(await jobProgress() === null, '再開が終わったら途中経過は消える');

// 3) 「破棄する」
await page.evaluate(() => window.largepic.mosaic.clear());
await page.setInputFiles('#fileVideo', vid);
await page.waitForSelector('#dlgCrop[open]', { timeout: 20000 });
await page.click('#dlgCrop [data-ok]');
await page.waitForFunction(() => window.largepic.mosaic.tiles.length >= 3, null, { timeout: 120000, polling: 100 });
await page.evaluate(() => window.largepic.store.flush());
await page.reload();
await page.waitForSelector('#dlgRestore[open]');
await page.click('#restoreGo');
await page.waitForSelector('#dlgResume[open]', { timeout: 30000 });
await page.click('#rsDiscard');
await page.waitForTimeout(300);
check(await jobProgress() === null, '「破棄する」で途中経過が消える');

// 4) 裏のタブ（非表示）として動かしても、同じ結果になる
await page.evaluate(() => { window.largepic.mosaic.clear(); Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); });
await importVideo(vid);
const hidden = await info();
await page.evaluate(() => { delete document.hidden; });
check(hidden.n >= 8 && Math.abs(hidden.bb.w - base.bb.w) <= 30 && Math.abs(hidden.bb.h - base.bb.h) <= 30, `非表示（裏のタブ）の状態でも最後まで取り込める (${hidden.n}枚)`);

await browser.close(); server.close(); process.exit(fail?1:0);
