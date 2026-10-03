// 保存済みの元画像が読み込めない（真っ黒になる）状態でも、続きから再開して追加動画を取り込めること
// node test/e2e-broken-store.mjs
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
await page.evaluate(() => { window.largepic.mosaic.clear(); });
const A = [], B = [];
for (let k = 0; k < 40; k++) A.push([500 + k * 25, 600]);
for (let k = 0; k < 20; k++) B.push([1475 - k * 10, 600 + k * 5]);
for (let k = 0; k < 40; k++) B.push([1275, 700 + k * 30]);
const vidA = await makeVideo('vidA', A); const vidB = await makeVideo('vidB', B);
await importVideo(vidA);
await page.evaluate(() => window.largepic.store.flush());
const n0 = await page.evaluate(() => window.largepic.mosaic.tiles.length);
// 保存済みの元画像を「真っ黒な画像」に差し替える（読み込み失敗の再現）
await page.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('largepic'); r.onsuccess = () => res(r.result); });
  const c = document.createElement('canvas'); c.width = 8; c.height = 8; c.getContext('2d').fillRect(0, 0, 8, 8);
  const black = await new Promise((r) => c.toBlob(r, 'image/png'));
  const keys = await new Promise((res) => { const r = db.transaction('blobs').objectStore('blobs').getAllKeys(); r.onsuccess = () => res(r.result); });
  await new Promise((res) => { const t = db.transaction('blobs', 'readwrite'); for (const k of keys) if (typeof k === 'number') t.objectStore('blobs').put(black, k); t.oncomplete = res; });
  db.close();
});
await page.reload();
await page.waitForSelector('#dlgRestore[open]'); await page.click('#restoreGo');
await page.waitForFunction((n) => window.largepic.mosaic.tiles.length === n && !document.querySelector('#dlgProgress').open, n0, { timeout: 60000 });
const r1 = await page.evaluate(async () => { const {mosaic}=window.largepic; const c = await mosaic.exportCanvas({scale:0.25}); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let nz=0; for(let i=0;i<d.length;i+=4) if(d[i]+d[i+1]+d[i+2]<30) nz++; return {n: mosaic.tiles.length, bb: mosaic.bbox(), dark: nz/(d.length/4)}; });
console.log('restored from preview', JSON.stringify(r1));
check(r1.dark < 0.02, '元画像が壊れていてもプレビューから復元され、黒くならない');
await importVideo(vidB);
const r2 = await page.evaluate(() => ({ n: window.largepic.mosaic.tiles.length, bb: window.largepic.mosaic.bbox() }));
console.log('after B', JSON.stringify(r2));
check(r2.n > r1.n && r2.bb.h > r1.bb.h + 300, '壊れた元画像があっても追加動画を取り込める');
await browser.close(); server.close(); process.exit(fail?1:0);
