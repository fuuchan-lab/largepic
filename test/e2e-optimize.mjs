// 全体の位置の最適化: node test/e2e-optimize.mjs
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

let fail=0; const check=(c,m)=>{console.log(c?"OK ":"NG ",m); if(!c) fail++;};
// 一周して戻ってくる経路（□）：ずれの蓄積を、ループの測定で全体に分散できるか
const P = [];
const S = 18;
for (let k = 0; k < 26; k++) P.push([400 + k * S, 600]);
for (let k = 0; k < 26; k++) P.push([400 + 25 * S, 600 + k * S]);
for (let k = 0; k < 26; k++) P.push([400 + (25 - k) * S, 600 + 25 * S]);
for (let k = 0; k < 26; k++) P.push([400, 600 + (25 - k) * S]);
const vid = await makeVideo("vidOpt", P);
await page.evaluate(() => window.largepic.mosaic.clear());
await importVideo(vid);
const a = await page.evaluate(() => {
  const { mosaic, linkResidual } = window.largepic;
  const t = mosaic.tiles;
  return { n: t.length, withLinks: t.filter((x) => x.links && x.links.length).length, links: t.reduce((s, x) => s + (x.links?.length || 0), 0), res: linkResidual(mosaic) };
});
console.log(JSON.stringify(a));
check(a.n >= 12, "ぐるっと一周の動画を取り込めた (" + a.n + "枚)");
check(a.withLinks >= a.n - 2 && a.links > a.n, "各タイルが近くのタイルとの相対位置を覚えている (" + a.links + "件)");
check(a.res.rms < 2.5, "取り込み直後の食い違いは小さい (" + a.res.rms.toFixed(2) + "px)");
// 位置にずれを仕込む：コマごとに少しずつ流れる（蓄積するずれ）＋ランダム
const r = await page.evaluate(() => {
  const { mosaic, optimizePositions, linkResidual } = window.largepic;
  const tl = mosaic.tiles.filter((t) => t.placed);
  const truth = tl.map((t) => [t.x, t.y]);
  let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
  tl.forEach((t, i) => { t.x += Math.round(i * 0.8 + rnd() * 6); t.y += Math.round(-i * 0.5 + rnd() * 6); });
  const err = () => {
    const dx = tl.map((t, i) => t.x - truth[i][0]), dy = tl.map((t, i) => t.y - truth[i][1]);
    const mx = dx.reduce((p, q) => p + q, 0) / dx.length, my = dy.reduce((p, q) => p + q, 0) / dy.length;
    return Math.sqrt(dx.reduce((p, q, i) => p + (q - mx) ** 2 + (dy[i] - my) ** 2, 0) / dx.length);
  };
  const e0 = err(), r0 = linkResidual(mosaic).rms;
  const res = optimizePositions(mosaic);
  return { e0, e1: err(), r0, r1: linkResidual(mosaic).rms, applied: res.applied, moved: res.moved };
});
console.log(JSON.stringify(r));
check(r.applied, "ずれた位置を最適化で直した（" + r.moved + "枚）");
check(r.e1 < r.e0 * 0.35, "本来の位置とのずれが大きく減る（" + r.e0.toFixed(1) + "px → " + r.e1.toFixed(1) + "px）");
check(r.r1 < r.r0 * 0.5, "測定との食い違いが減る（" + r.r0.toFixed(1) + " → " + r.r1.toFixed(1) + "px）");
// 保存して開き直しても測定が残る
await page.evaluate(() => window.largepic.store.flush());
await page.reload(); await page.waitForSelector("#dlgRestore[open]"); await page.click("#restoreGo");
await page.waitForFunction((n) => window.largepic.mosaic.tiles.length >= n, a.n, { timeout: 30000 });
const b = await page.evaluate(() => window.largepic.mosaic.tiles.filter((x) => x.links && x.links.length).length);
check(b >= a.withLinks - 2, "開き直しても位置の測定が残っている (" + b + "枚)");
await browser.close(); server.close();
console.log(fail ? "FAILED" : "all passed"); process.exit(fail ? 1 : 0);
