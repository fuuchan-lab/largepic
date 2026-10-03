// 取り込み済みの範囲にできた小さな抜けを、あとから通過した動画で埋めること
// node test/e2e-holes.mjs
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
const A = []; for (let k = 0; k < 40; k++) A.push([500 + k * 20, 600]);
const Brev = [...A].reverse();
await importVideo(await makeVideo('vidH1', A));
// 取り込み済みの画像の一部を消して、小さな抜け（穴）を作る
const hole = await page.evaluate(() => {
  const { mosaic } = window.largepic;
  const bb = mosaic.bbox();
  for (let tries = 0; tries < 400; tries++) {
    const px = bb.x + 100 + Math.random() * (bb.w - 200), py = bb.y + 60 + Math.random() * (bb.h - 120);
    const cover = mosaic.tiles.filter((t) => px >= t.x && px < t.x + t.w && py >= t.y && py < t.y + t.h);
    if (cover.length < 2) continue;
    // これらを消したあとの、点まわり 160×160 の未取得面積
    const keep = mosaic.tiles.filter((t) => !cover.includes(t));
    const saved = mosaic.tiles; mosaic.tiles = keep;
    const u = mosaic.uncoveredArea(px - 80, py - 80, 160, 160);
    mosaic.tiles = saved;
    if (u.area > 600 && u.area < 9000) {
      for (const t of cover) mosaic.remove(t);
      return { px, py, before: mosaic.uncoveredArea(px - 80, py - 80, 160, 160).area, removed: cover.length, n: mosaic.tiles.length };
    }
  }
  return null;
});
console.log('hole', JSON.stringify(hole));
check(!!hole, '小さな抜けを作れた');
await importVideo(await makeVideo('vidH2', Brev));
const after = await page.evaluate(({ px, py }) => ({ area: window.largepic.mosaic.uncoveredArea(px - 80, py - 80, 160, 160).area, n: window.largepic.mosaic.tiles.length }), hole);
console.log('after', JSON.stringify(after));
check(after.area < hole.before * 0.2, `2回目の動画が通過して抜けが埋まる (${hole.before}px² → ${after.area}px²)`);
check(after.n > hole.n, `抜けを覆うタイルが追加される (${hole.n} → ${after.n}枚)`);
await browser.close(); server.close(); process.exit(fail?1:0);
