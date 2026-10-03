// 分割保存（タイル形式 ZIP）とビューアの試験: node test/e2e-tiles.mjs
//  1) 取り込んだ画像を分割保存 → ビューアで 1:1 表示したときの画素が、1枚で書き出した画像と一致する
//  2) 画素数の制限を超える巨大な画像（30800×40800）でも保存でき、ビューアで継ぎ目なく見られる
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'www');
const tmp = path.join(process.env.TMPDIR || os.tmpdir(), 'largepic-tiles');
await mkdir(tmp, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/json' };
const server = createServer(async (req, res) => { try { const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); const f = p.endsWith('/') ? p + 'index.html' : p; res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); } catch { res.writeHead(404); res.end(); } }).listen(0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await page.goto(`http://localhost:${server.address().port}/`);
let fail = 0;
const check = (c, m) => { console.log(c ? 'OK ' : 'NG ', m); if (!c) fail++; };

// --- 1) 小さな実画像で、ピクセルまで一致するか ---
// 模様のある画像を 2×2 のタイルとして mosaic に置く（重なり付き）
const buildMosaic = () => page.evaluate(async () => {
  const { mosaic } = window.largepic;
  mosaic.clear();
  const W = 900, H = 700;
  const art = document.createElement('canvas'); art.width = W; art.height = H;
  const g = art.getContext('2d');
  let s = 3; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < H; y += 10) for (let x = 0; x < W; x += 10) { g.fillStyle = `rgb(${r() * 255 | 0},${r() * 255 | 0},${r() * 255 | 0})`; g.fillRect(x, y, 10, 10); }
  const mk = async (sx, sy, w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(art, sx, sy, w, h, 0, 0, w, h);
    const src = await new Promise((res) => c.toBlob(res, 'image/png'));
    const thumb = await createImageBitmap(c);
    mosaic.add({ x: sx, y: sy, w, h, placed: true, thumb, thumbScale: 1, src, sx: 0, sy: 0, feat: null });
  };
  await mk(0, 0, 500, 400); await mk(400, 0, 500, 400); await mk(0, 300, 500, 400); await mk(400, 300, 500, 400);
  return { W, H };
});
await buildMosaic();
const res = await page.evaluate(async () => {
  const { mosaic } = window.largepic;
  const { exportTiles } = await import('/js/tiles.js');
  const t0 = performance.now();
  const { blob, manifest } = await exportTiles(mosaic, { tileSize: 256, background: '#ffffff' });
  const ms = performance.now() - t0;
  window.__zip = blob;
  const { ZipReader } = await import('/js/tiles.js');
  const z = await ZipReader.open(blob);
  return { size: blob.size, ms, manifest, names: [...z.map.keys()].length };
});
console.log('分割保存', JSON.stringify({ ...res.manifest, createdAt: undefined }), `${(res.size / 1024).toFixed(0)}KB ${res.ms.toFixed(0)}ms`, 'ファイル数', res.names);
check(res.manifest.width === 900 && res.manifest.height === 700 && res.manifest.levels === 2, '大きさとレベル数が正しい');

await page.evaluate(() => document.querySelector('#viewer').hidden = false);
await page.evaluate(async () => { await window.largepic.viewer.load(window.__zip); });
const info = await page.evaluate(() => ({ tiled: window.largepic.viewer.tiled, w: window.largepic.viewer.w, h: window.largepic.viewer.h }));
check(info.tiled && info.w === 900 && info.h === 700, 'ビューアが分割保存（ZIP）を開ける');

// 1:1 で表示 → 1枚書き出しの画素と比較（タイル読み込みの完了を待つ）
const cmp = await page.evaluate(async () => {
  const { mosaic, viewer } = window.largepic;
  const ref = await mosaic.exportCanvas({ scale: 1 });
  const rd = ref.getContext('2d').getImageData(0, 0, ref.width, ref.height).data;
  viewer.dpr = 1; viewer.resize();
  viewer.setView(1, 0, 0, false);
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 50)); if (!viewer.source.pending.size) break; }
  viewer.draw();
  await new Promise((r) => setTimeout(r, 100));
  const c = document.querySelector('#viewerCanvas');
  const w = Math.min(c.width, 900), h = Math.min(c.height, 700);
  const oy = Math.round(viewer.oy);   // 画像は縦に中央寄せされる
  const vd = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let bad = 0, n = 0, max = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = ((y + oy) * c.width + x) * 4, b = (y * ref.width + x) * 4;
    const d = Math.abs(vd[a] - rd[b]) + Math.abs(vd[a + 1] - rd[b + 1]) + Math.abs(vd[a + 2] - rd[b + 2]);
    max = Math.max(max, d); if (d > 0) bad++; n++;
  }
  return { bad, n, max, cw: c.width, ch: c.height };
});
console.log(JSON.stringify(cmp));
check(cmp.bad === 0, `1:1 表示が元の画像とピクセルまで一致（違う画素 ${cmp.bad} / ${cmp.n}）`);

// 縮小表示（レベル1・2）でも全体の色合いが合い、穴があかない
const small = await page.evaluate(async () => {
  const { viewer } = window.largepic;
  viewer.fit(false);
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 50)); if (!viewer.source.pending.size) break; }
  viewer.draw(); await new Promise((r) => setTimeout(r, 100));
  const c = document.querySelector('#viewerCanvas'), g = c.getContext('2d');
  const x0 = Math.round(viewer.ox), y0 = Math.round(viewer.oy), w = Math.round(viewer.w * viewer.s), h = Math.round(viewer.h * viewer.s);
  const d = g.getImageData(x0 + 2, y0 + 2, w - 4, h - 4).data;
  let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 20) dark++;
  return { s: viewer.s, dark: dark / (d.length / 4) };
});
check(small.dark < 0.01, `縮小表示で穴（背景色の抜け）がない (s=${small.s.toFixed(2)})`);

// 丸く切り抜いた分割保存：四隅は透明（ビューアの背景）、中心は画像
const circ = await page.evaluate(async () => {
  const { mosaic, viewer } = window.largepic;
  const { exportTiles } = await import('/js/tiles.js');
  const { blob, manifest } = await exportTiles(mosaic, { tileSize: 256, background: '#ffffff', circle: true, region: { x: 100, y: 0, w: 700, h: 700 } });
  await viewer.load(blob);
  viewer.dpr = 1; viewer.resize(); viewer.setView(1, 0, 0, false);
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 50)); if (!viewer.source.pending.size) break; }
  viewer.draw(); await new Promise((r) => setTimeout(r, 100));
  const g = document.querySelector('#viewerCanvas').getContext('2d');
  const oy = Math.round(viewer.oy), ox = Math.round(viewer.ox);
  const px = (x, y) => Array.from(g.getImageData(ox + x, oy + y, 1, 1).data);
  return { circle: manifest.circle, corner: px(3, 3), center: px(350, 350), ext: manifest.tileExt[1] };
});
console.log(JSON.stringify(circ));
check(circ.circle && circ.ext === 'png' && circ.corner[0] < 30 && (circ.center[0] + circ.center[1] + circ.center[2]) > 30, '丸の分割保存：四隅は透明で、中心に画像がある');

// --- 2) 画素数の制限を超える巨大な画像 ---
const big = await page.evaluate(async () => {
  const { mosaic } = window.largepic;
  mosaic.clear();
  const { exportTiles } = await import('/js/tiles.js');
  const colors = ['#e53935', '#43a047', '#1e88e5', '#fdd835'];
  const pos = [[0, 0], [30000, 0], [0, 40000], [30000, 40000]];
  for (let i = 0; i < 4; i++) {
    const c = document.createElement('canvas'); c.width = 800; c.height = 800;
    const g = c.getContext('2d'); g.fillStyle = colors[i]; g.fillRect(0, 0, 800, 800);
    g.fillStyle = '#000'; g.fillRect(100, 100, 50, 50);
    const src = await new Promise((res) => c.toBlob(res, 'image/png'));
    mosaic.add({ x: pos[i][0], y: pos[i][1], w: 800, h: 800, placed: true, thumb: await createImageBitmap(c), thumbScale: 1, src, sx: 0, sy: 0, feat: null });
  }
  const t0 = performance.now();
  const { blob, manifest } = await exportTiles(mosaic, { background: '#ffffff' });
  window.__bigzip = blob;
  return { w: manifest.width, h: manifest.height, levels: manifest.levels, size: blob.size, ms: performance.now() - t0 };
});
console.log('巨大', JSON.stringify(big));
check(big.w === 30800 && big.h === 40800, `1.2G画素（${big.w}×${big.h}）でも保存できる（ZIP ${(big.size / 1024).toFixed(0)}KB, ${big.ms.toFixed(0)}ms）`);
const bigv = await page.evaluate(async () => {
  const { viewer } = window.largepic;
  await viewer.load(window.__bigzip);
  const wait = async () => { for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 60)); if (!viewer.source.pending.size) break; } viewer.draw(); await new Promise((r) => setTimeout(r, 80)); };
  await wait();
  const c = document.querySelector('#viewerCanvas'), g = c.getContext('2d');
  const px = (sx, sy) => Array.from(g.getImageData(Math.round(sx), Math.round(sy), 1, 1).data.slice(0, 3));
  const at = (ix, iy) => [viewer.ox + ix * viewer.s, viewer.oy + iy * viewer.s];
  const fitS = viewer.s;
  // 全体表示で、4隅の色の四角が見える
  const fit = [at(400, 400), at(30400, 400), at(400, 40400), at(30400, 40400)].map(([x, y]) => px(x, y));
  // 右下の四角へ 1:1 まで拡大 → 色と、中の黒い四角が見える
  viewer.setView(1, 400 + 0, 0, false);
  const cx = 30000 + 120, cy = 40000 + 120;
  viewer.setView(1, c.clientWidth / 2 - cx, c.clientHeight / 2 - cy, false);
  await wait();
  const zoomed = { inside: px(c.clientWidth / 2, c.clientHeight / 2), outside: px(c.clientWidth / 2 + 150, c.clientHeight / 2 + 150), tilesLoaded: viewer.source.cache.size };
  return { fitS, fit, zoomed };
});
console.log(JSON.stringify(bigv));
const near = (a, b, t = 40) => a.every((v, i) => Math.abs(v - b[i]) <= t);
check(near(bigv.fit[0], [229, 57, 53]) && near(bigv.fit[1], [67, 160, 71]) && near(bigv.fit[2], [30, 136, 229]) && near(bigv.fit[3], [253, 216, 53], 50),
  '巨大な画像を全体表示すると4隅の色の四角が見える（縮小タイルで継ぎ目なく表示）');
check(near(bigv.zoomed.inside, [0, 0, 0], 3), '1:1 まで拡大すると、元の解像度のタイルから細部（黒い四角）が見える');
check(near(bigv.zoomed.outside, [253, 216, 53], 3), '拡大しても隣のタイルとの継ぎ目に隙間がない');

// --- 3) 画面の操作：保存ダイアログで「分割保存」→ ZIP をダウンロード → ［閲覧］で開く ---
await page.evaluate(() => { document.querySelector('#viewer').hidden = true; window.largepic.viewer.dispose(); });
await buildMosaic();
await page.click('#btnExport');
await page.selectOption('#expType', 'tiles');
await page.click('#expGo');
await page.waitForSelector('#expDownload:not([hidden])', { timeout: 60000 });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#expDownload')]);
const zipPath = path.join(tmp, 'ui.zip');
await dl.saveAs(zipPath);
check(/\.zip$/.test(dl.suggestedFilename()), `ZIP としてダウンロードされる (${dl.suggestedFilename()})`);
await page.click('#dlgExport [data-close]');
await page.setInputFiles('#fileView', zipPath);
await page.waitForFunction(() => window.largepic.viewer.tiled, null, { timeout: 30000 });
check(await page.evaluate(() => window.largepic.viewer.w === 900 && window.largepic.viewer.h === 700), '保存した ZIP を［閲覧］で開ける');

await browser.close(); server.close();
console.log(fail ? `${fail} failed` : 'all passed', ' 出力:', tmp);
process.exit(fail ? 1 : 0);
