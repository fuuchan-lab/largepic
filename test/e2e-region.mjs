// 取り込み済みの部分は保存せず、新しい部分だけを保存する: node test/e2e-region.mjs
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
const P = [];
for (let k = 0; k < 40; k++) P.push([400 + k * 18, 600]);
for (let k = 0; k < 24; k++) P.push([400 + 39 * 18, 600 + k * 16]);
const vid = await makeVideo('vidRegion', P);
await page.evaluate(() => window.largepic.mosaic.clear());
await importVideo(vid);
const info = await page.evaluate(async () => {
  const { mosaic } = window.largepic;
  const full = mosaic.tiles[0].w * mosaic.tiles[0].h;
  const stored = mosaic.tiles.reduce((a, t) => a + (t.iw ?? t.w) * (t.ih ?? t.h), 0);
  const partial = mosaic.tiles.filter((t) => t.iw != null && (t.iw < t.w || t.ih < t.h)).length;
  const c = await mosaic.exportCanvas({ scale: 1 });
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0;
  return { n: mosaic.tiles.length, partial, saved: 1 - stored / (full * mosaic.tiles.length), hash: h, bb: mosaic.bbox(), w: c.width, h2: c.height };
});
console.log(JSON.stringify(info));
check(info.n >= 6 && info.partial >= info.n - 2, `2枚目以降は、新しい部分だけを保存している (${info.partial}/${info.n}枚)`);
check(info.saved > 0.25, `保存する画素数が減る（${(info.saved * 100).toFixed(0)}% 削減）`);

// 元の地図と一致する（新しい部分だけを保存しても、継ぎ目や欠けがない）
const diff = await page.evaluate(async (cands) => {
  const { mosaic } = window.largepic;
  const c = await mosaic.exportCanvas({ scale: 1 });
  const bb = mosaic.bbox(), t1 = mosaic.tiles.find((t) => t.id === 1);
  const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let best = 1e9, cov = 0;
  for (const [x0, y0] of cands) {
    const wx = x0 + (bb.x - t1.x), wy = y0 + 110 + (bb.y - t1.y);
    if (wx < 0 || wy < 0 || wx + c.width > 3000 || wy + c.height > 3000) continue;
    const w = document.createElement('canvas'); w.width = c.width; w.height = c.height;
    w.getContext('2d').drawImage(window.__world, wx, wy, c.width, c.height, 0, 0, c.width, c.height);
    const b = w.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0, n = 0;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) { if (!mosaic.covers(bb.x + x, bb.y + y)) continue; const i = (y * c.width + x) * 4; s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n++; }
    if (s / n / 3 < best) { best = s / n / 3; cov = n; }
  }
  return { best, cov };
}, P);
check(diff.best < 6, `元の地図との平均差が小さい（${diff.best.toFixed(2)}）`);
// 覆われていない画素（透明）がない：通った経路はすべて画像がある
const gaps = await page.evaluate(() => {
  const { mosaic } = window.largepic; const bb = mosaic.bbox();
  // 経路上（東へ→南へ。右端はL字の角で元から未取得なので除く）の帯の中の点で、覆われていないものを数える
  let miss = 0, n = 0;
  for (let x = 5; x < bb.w - 45; x += 7) for (const y of [bb.y + 300]) { n++; if (!mosaic.covers(bb.x + x, y)) { miss++; (window.__miss ||= []).push([x, y - bb.y, mosaic.tiles.map((t) => [t.x, t.y, t.ix, t.iy, t.iw ?? t.w, t.ih ?? t.h].join(",")).join(" ; ")]); } }
  return { miss, n, m: window.__miss };
});
check(gaps.miss === 0, `通った所に抜けがない (${gaps.miss}/${gaps.n})`);

// 保存 → 読み込み直し（続きから）でも、見た目が同じ
await page.evaluate(() => window.largepic.store.flush());
await page.reload();
await page.waitForSelector('#dlgRestore[open]');
await page.click('#restoreGo');
await page.waitForFunction((n) => window.largepic.mosaic.tiles.length === n && !document.querySelector('#dlgProgress').open, info.n, { timeout: 60000 });
const after = await page.evaluate(async () => {
  const { mosaic } = window.largepic;
  const c = await mosaic.exportCanvas({ scale: 1 });
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0;
  return { hash: h, partial: mosaic.tiles.filter((t) => t.iw != null && (t.iw < t.w || t.ih < t.h)).length, bb: mosaic.bbox() };
});
check(after.hash === info.hash && after.bb.w === info.bb.w && after.bb.h === info.bb.h, '保存して開き直しても、書き出した画像がまったく同じ');
check(after.partial === info.partial, '一部だけ保存したタイルの情報も戻る');

// 分割保存（ZIP）も同じ見た目
const zipOk = await page.evaluate(async () => {
  const { mosaic, viewer } = window.largepic;
  const { exportTiles } = await import('/js/tiles.js');
  const { blob, manifest } = await exportTiles(mosaic, { tileSize: 256 });
  return manifest.width === mosaic.bbox().w && manifest.height === mosaic.bbox().h && blob.size > 1000;
});
check(zipOk, '分割保存（ZIP）も作れる');
await browser.close(); server.close(); process.exit(fail?1:0);
