// 海のように模様が少ない（線と点だけ）地図でも、位置がずれず、誤警告も出ないこと
// node test/e2e-sparse.mjs
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
// 模様の少ない世界（海）に置き換える：ほぼ一様な水色＋かすかなノイズ＋まばらな浮標・海岸線
await page.evaluate(() => {
  const c = window.__world, g = c.getContext('2d');
  g.fillStyle = '#bfe3f0'; g.fillRect(0, 0, 3000, 3000);
  let s = 5; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const img = g.getImageData(0, 0, 3000, 3000), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 3; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  g.strokeStyle = '#f4f1e8'; g.lineWidth = 14;
  g.beginPath(); g.moveTo(700, 0); g.bezierCurveTo(900, 900, 600, 1500, 1000, 3000); g.stroke();
  g.fillStyle = '#c33'; for (let i = 0; i < 90; i++) { g.beginPath(); g.arc(300 + r() * 2500, 300 + r() * 2500, 9, 0, 7); g.fill(); }
  g.fillStyle = '#334'; g.font = '24px sans-serif'; for (let i = 0; i < 70; i++) g.fillText('M.Sh', 300 + r() * 2500, 300 + r() * 2500);
});
await page.evaluate(() => { window.largepic.mosaic.clear(); });
// 海を縦横にジグザグに進む動画
const P = [];
for (let k = 0; k < 40; k++) P.push([500 + k * 18, 600]);
for (let k = 0; k < 20; k++) P.push([1220, 600 + k * 18]);
for (let k = 0; k < 40; k++) P.push([1220 - k * 18, 960]);
await importVideo(await makeVideo('vidSea', P));
console.log('WARN?', await page.evaluate(() => document.querySelector('#dlgWarn').open ? document.querySelector('#dlgWarn').innerText.replace(/\n+/g,' / ') : 'none'));
const res = await page.evaluate(async (cands) => {
  const { mosaic } = window.largepic;
  const c = await mosaic.exportCanvas({ scale: 1 });
  const bb = mosaic.bbox(), t1 = mosaic.tiles.find((t) => t.id === 1);
  const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let best = 1e9;
  for (const [x0, y0] of cands) {
    const wx = x0 + (bb.x - t1.x), wy = y0 + 110 + (bb.y - t1.y);
    if (wx < 0 || wy < 0 || wx + c.width > 3000 || wy + c.height > 3000) continue;
    const w = document.createElement('canvas'); w.width = c.width; w.height = c.height;
    w.getContext('2d').drawImage(window.__world, wx, wy, c.width, c.height, 0, 0, c.width, c.height);
    const b = w.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0, n = 0;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) { if (!mosaic.covers(bb.x + x, bb.y + y)) continue; const i = (y * c.width + x) * 4; s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n++; }
    best = Math.min(best, s / n / 3);
  }
  return { diff: best, n: mosaic.tiles.length, bb, weak: mosaic.tiles.filter((t) => t.weak).length };
}, P);
console.log(JSON.stringify(res));
const tl = await page.evaluate(() => window.largepic.mosaic.tiles.map((t) => ({ t: t.vt, x: t.x, y: t.y, conf: +(t.conf||0).toFixed(2), weak: t.weak })));
// 真の位置との誤差（最初のタイルを基準）
const truth = (t) => P[Math.min(P.length - 1, Math.round(t * 10))];
const t0 = tl[0], p0 = truth(t0.t);
let maxErr = 0;
for (const t of tl) { const p = truth(t.t); maxErr = Math.max(maxErr, Math.hypot((t.x - t0.x) - (p[0] - p0[0]), (t.y - t0.y) - (p[1] - p0[1]))); if (0) console.log('tile t=', t.t.toFixed(2), 'err', (t.x - t0.x) - (p[0] - p0[0]), (t.y - t0.y) - (p[1] - p0[1]), 'conf', t.conf, t.weak ? 'WEAK' : ''); }
check(!(await page.evaluate(() => document.querySelector('#dlgWarn').open)), '模様の少ない海で、回転・拡大の誤警告が出ない');
check(res.diff < 4, `模様の少ない海でも位置がずれない（元の地図との平均差 ${res.diff.toFixed(2)}）`);
check(Math.abs(res.bb.w - 1110) < 40 && Math.abs(res.bb.h - 976) < 40, `全体の大きさが合う (${res.bb.w}x${res.bb.h})`);
check(maxErr <= 6, `すべてのタイルの位置誤差が小さい（最大 ${maxErr.toFixed(1)}px）`);
await browser.close(); server.close(); process.exit(fail?1:0);
