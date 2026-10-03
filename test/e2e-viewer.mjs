// 大きな画像ビューアの試験: node test/e2e-viewer.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'www');
const tmp = path.join(process.env.TMPDIR || os.tmpdir(), 'largepic-viewer');
await mkdir(tmp, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/json' };
const server = createServer(async (req, res) => { try { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); const f = p.endsWith('/') ? p + 'index.html' : p; res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); } catch { res.writeHead(404); res.end(); } }).listen(0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await page.goto(`http://localhost:${server.address().port}/`);
let fail = 0;
const check = (c, m) => { console.log(c ? 'OK ' : 'NG ', m); if (!c) fail++; };

// 5000×7000 の大きな画像：1000px ごとにマス目を塗り分け、各マスの色は座標から決まる
const W = 5000, H = 7000;
const data = await page.evaluate(async ([W, H]) => {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  for (let y = 0; y < H; y += 100) for (let x = 0; x < W; x += 100) {
    g.fillStyle = `rgb(${(x / 100 * 5) % 256},${(y / 100 * 3) % 256},${((x + y) / 100 * 7) % 256})`;
    g.fillRect(x, y, 100, 100);
  }
  g.fillStyle = '#fff'; g.font = 'bold 300px sans-serif'; g.fillText('TOP-LEFT', 100, 400); g.fillText('BOTTOM-RIGHT', W - 2400, H - 200);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}, [W, H]);
const file = path.join(tmp, 'big.png');
await writeFile(file, Buffer.from(data, 'base64'));
console.log('画像', ((await readFile(file)).length / 1048576).toFixed(1), 'MB');

const t0 = Date.now();
await page.setInputFiles('#fileView', file);
await page.waitForFunction(() => !document.querySelector('#viewer').hidden && !document.querySelector('#viewerLoading').hidden === false && window.largepic.viewer.img, null, { timeout: 60000 });
console.log('読み込み', Date.now() - t0, 'ms ／ 縮小段', await page.evaluate(() => window.largepic.viewer.levels.map((l) => l.k).join(',')));
const st = () => page.evaluate(() => { const v = window.largepic.viewer; return { s: v.s, ox: v.ox, oy: v.oy, fit: v.fitScale, dpr: v.dpr }; });
const px = (x, y) => page.evaluate(([x, y]) => { const c = document.querySelector('#viewerCanvas'); const d = c.getContext('2d').getImageData(Math.round(x * (window.devicePixelRatio)), Math.round(y * window.devicePixelRatio), 1, 1).data; return [d[0], d[1], d[2]]; }, [x, y]);
const expected = (ix, iy) => { const cx = Math.floor(ix / 100) * 100, cy = Math.floor(iy / 100) * 100; return [(cx / 100 * 5) % 256, (cy / 100 * 3) % 256, ((cx + cy) / 100 * 7) % 256]; };
const near = (a, b, t = 12) => a.every((v, i) => Math.abs(v - b[i]) <= t);

let a = await st();
check(Math.abs(a.s - a.fit) < 1e-6, `最初は全体表示 (${(a.s * 100).toFixed(1)}%)`);
await page.screenshot({ path: path.join(tmp, 'v-fit.png') });
// 全体表示でも画像の色が正しい（縮小画像から描画）
{ const ix = 2550, iy = 3550; const sx = a.ox + ix * a.s, sy = a.oy + iy * a.s;
  const c = await px(sx, sy); check(near(c, expected(ix, iy), 25), `全体表示の色が正しい ${JSON.stringify(c)} ≈ ${JSON.stringify(expected(ix, iy))}`); }

// ホイールで拡大（画面中央を基準に）
const cx = 210, cy = 430;
await page.mouse.move(cx, cy);
for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -300);
await page.waitForTimeout(100);
let b = await st();
check(b.s > a.s * 3, `ホイールで拡大できる (${(a.s * 100).toFixed(1)}% → ${(b.s * 100).toFixed(1)}%)`);
// 拡大しても、カーソル位置の画像の点が動かない
{ const ix = (cx - a.ox) / a.s, iy = (cy - a.oy) / a.s; const nx = (cx - b.ox) / b.s, ny = (cy - b.oy) / b.s;
  check(Math.hypot(ix - nx, iy - ny) < 3, `カーソル位置を中心に拡大 (ずれ ${Math.hypot(ix - nx, iy - ny).toFixed(2)}px)`); }
// 拡大後の色
{ const ix = (cx - b.ox) / b.s, iy = (cy - b.oy) / b.s; const c = await px(cx, cy);
  check(near(c, expected(ix, iy), 12), `拡大後の色が正しい ${JSON.stringify(c)} ≈ ${JSON.stringify(expected(ix, iy))}`); }
await page.screenshot({ path: path.join(tmp, 'v-zoom.png') });

// ドラッグで移動
await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 120, cy - 80, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(600);
let c2 = await st();
check(c2.ox < b.ox - 100 && c2.oy < b.oy - 60, `ドラッグで移動できる (${(c2.ox - b.ox).toFixed(0)}, ${(c2.oy - b.oy).toFixed(0)})`);

// 等倍ボタン：画像1pxが画面の物理1px
await page.click('#viewer100');
await page.waitForTimeout(400);
let d = await st();
check(Math.abs(d.s * d.dpr - 1) < 0.01, `等倍表示 (${(d.s * d.dpr * 100).toFixed(0)}%)`);

// 全体ボタン / ダブルクリックの切り替え
await page.click('#viewerFit'); await page.waitForTimeout(400);
let e1 = await st(); check(Math.abs(e1.s - e1.fit) < 1e-3, '全体ボタンで全体表示に戻る');
await page.mouse.dblclick(cx, cy); await page.waitForTimeout(400);
let e2 = await st(); check(e2.s > e1.s * 2, 'ダブルクリックで拡大');
await page.mouse.dblclick(cx, cy); await page.waitForTimeout(400);
let e3 = await st(); check(Math.abs(e3.s - e3.fit) < 1e-3, 'もう一度ダブルクリックで全体表示');

// 縮小の下限（全体より小さくなりすぎない）
for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 400);
await page.waitForTimeout(100);
let f = await st(); check(f.s >= Math.min(f.fit, 1 / f.dpr) * 0.8 - 1e-6, '縮小しすぎない');

// 最大まで拡大して端の文字が見える（右下へ）
await page.click('#viewerFit');
await page.waitForTimeout(400);
await page.click('#viewerClose');
check(await page.evaluate(() => document.querySelector('#viewer').hidden), '閉じるでビューアが閉じる');
check(await page.evaluate(() => window.largepic.viewer.levels.length === 0 && !window.largepic.viewer.img), '閉じるとメモリを解放する');

await browser.close(); server.close();
console.log(fail ? `${fail} failed` : 'all passed', ' 出力:', tmp);
process.exit(fail ? 1 : 0);
