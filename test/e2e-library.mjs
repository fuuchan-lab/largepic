// 保存した画像のライブラリ（閲覧の入口）の試験: node test/e2e-library.mjs

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


// 取り込み済みの画像（模様のある 900×700）を用意
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
const open = (sel) => page.evaluate((s) => !document.querySelector(s).hidden, sel);
const cards = () => page.evaluate(() => document.querySelectorAll('#galleryList .gcard').length);

// 1) 何も保存していないとき：［閲覧］は一覧を開き、空の案内が出る
await page.click('#btnViewer');
check(await open('#gallery'), '［閲覧］で保存した画像の一覧が開く');
await page.waitForFunction(() => !document.querySelector('#galleryEmpty').hidden, null, { timeout: 5000 }).catch(() => {});
check(await page.evaluate(() => !document.querySelector('#galleryEmpty').hidden), '空のときは案内が出る');
await page.click('#galleryClose');

// 2) 1枚の画像として保存 → 一覧に自動で入る
await page.click('#btnExport');
await page.selectOption('#expType', 'image/png');
await page.click('#expGo');
await page.waitForSelector('#expDownload:not([hidden])', { timeout: 60000 });
await page.waitForFunction(() => !document.querySelector('#expLib').hidden, null, { timeout: 10000 });
check(true, '保存すると「閲覧の一覧にも入りました」と表示される');
await page.click('#dlgExport [data-close]');

// 3) 分割保存も入る
await page.click('#btnExport');
await page.selectOption('#expType', 'tiles');
await page.click('#expGo');
await page.waitForFunction(() => !document.querySelector('#expLib').hidden, null, { timeout: 60000 });
await page.click('#dlgExport [data-close]');

// 4) ［閲覧］：保存した画像が新しい順に並び、サムネイルがある
await page.click('#btnViewer');
await page.waitForFunction(() => document.querySelectorAll('#galleryList .gcard').length === 2, null, { timeout: 10000 });
const info = await page.evaluate(() => [...document.querySelectorAll('#galleryList .gcard')].map((c) => ({
  name: c.querySelector('b').textContent, tiles: !!c.querySelector('.gbadge'), thumb: c.querySelector('.gthumb').style.backgroundImage.length > 10, text: c.querySelector('.ginfo').innerText.replace(/\n/g, ' ') })));
console.log(JSON.stringify(info));
check(info.length === 2 && info[0].tiles && !info[1].tiles, '新しい順（分割保存が先頭）で並ぶ');
check(info.every((i) => i.thumb), 'サムネイルが付く（1枚の画像も、分割保存も）');
check(info.every((i) => /900×700px/.test(i.text)), '大きさ（900×700px）が表示される');

await page.screenshot({ path: path.join(tmp, 'gallery.png') });
// 5) 一覧から開く → ビューアで見られる／閉じると一覧に戻る
await page.click('#galleryList .gcard:nth-child(2) .gthumb');   // 1枚の画像
await page.waitForFunction(() => window.largepic.viewer.source && !document.querySelector('#viewer').hidden, null, { timeout: 15000 });
check(await page.evaluate(() => window.largepic.viewer.w === 900 && window.largepic.viewer.h === 700 && !window.largepic.viewer.tiled), '一覧から開くとビューアで見られる（1枚の画像）');
await page.click('#viewerClose');
check(await open('#gallery'), 'ビューアを閉じると一覧に戻る');
await page.click('#galleryList .gcard:nth-child(1) .gthumb');   // 分割保存
await page.waitForFunction(() => window.largepic.viewer.tiled, null, { timeout: 15000 });
check(true, '一覧から分割保存も開ける');
await page.click('#viewerOpen');   // 「一覧へ」
check(await open('#gallery') && !(await open('#viewer')), '［一覧へ］で一覧に戻る');

// 6) 再読み込みしても残っている（端末に保存されている）
await page.reload();
await page.click('#restoreNew').catch(() => {});
await page.waitForTimeout(300);
await page.click('#btnViewer');
await page.waitForFunction(() => document.querySelectorAll('#galleryList .gcard').length === 2, null, { timeout: 10000 });
check(true, 'ページを開き直しても、保存した画像が一覧に残っている');

// 7) 削除
page.on('dialog', (d) => d.accept());
await page.click('#galleryList .gcard:nth-child(1) [data-act=del]');
await page.waitForFunction(() => document.querySelectorAll('#galleryList .gcard').length === 1, null, { timeout: 10000 });
check(true, '削除すると一覧から消える');

// 8) 最初の画面の「保存した大きな画像を見る」も一覧を開く
await page.click('#galleryClose');
await page.evaluate(() => window.largepic.mosaic.clear());
await page.click('.empty [data-action=viewer]');
check(await open('#gallery'), '最初の画面のリンクからも一覧が開く');

await browser.close(); server.close();
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
