// 絵の食い違い（矛盾）を見つけて止まり、取り消せること
// node test/e2e-conflict.mjs
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
    const d = await page.evaluate(([x, y, off]) => window.__shotT(x, y, off), pts[k]);
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
// off: 世界を横にずらして撮った絵（＝すでに取り込んだ部分と食い違う絵）
await page.evaluate(() => {
  window.__shotT = (x, y, off = 0) => {
    // off: 地図の見た目が少しずつ変わっていく度合い（0〜1。1 で色が反転）＝すでに取り込んだ部分と食い違う絵
    const w = 390, h = 844, o = document.createElement('canvas'); o.width = w; o.height = h;
    const q = o.getContext('2d');
    q.drawImage(window.__world, x, y, w, h, 0, 0, w, h);
    if (off > 0) { q.globalAlpha = off; q.globalCompositeOperation = 'difference'; q.fillStyle = '#fff'; q.fillRect(0, 0, w, h); q.globalAlpha = 1; q.globalCompositeOperation = 'source-over'; }
    q.fillStyle = '#fff'; q.fillRect(0, 0, w, 100); q.fillStyle = '#888'; q.fillRect(20, 40, w - 40, 44);
    q.fillStyle = '#fafafa'; q.fillRect(0, h - 100, w, 100); q.fillStyle = '#39f'; q.fillRect(30, h - 80, 60, 50);
    return o.toDataURL('image/png');
  };
});
const tiles = () => page.evaluate(() => window.largepic.mosaic.tiles.length);
const open = (sel) => page.evaluate((s) => document.querySelector(s).open, sel);
const waitConflict = async () => {
  await page.waitForFunction(() => document.querySelector('#dlgConflict').open || !document.querySelector('#dlgProgress').open, null, { timeout: 120000, polling: 300 });
  if (!(await open('#dlgConflict'))) { console.log('矛盾が検出されず取り込みが終了', await tiles(), '枚', JSON.stringify(await page.evaluate(() => window.largepic.mosaic.bbox()))); throw new Error('no conflict'); }
};

// 1) 矛盾の判定そのもの：正しい位置では矛盾なし、ずらすと矛盾あり
await page.evaluate(() => { window.largepic.mosaic.clear(); });
const A = []; for (let k = 0; k < 30; k++) A.push([500 + k * 20, 600, 0]);
await importVideo(await makeVideo('vidC0', A));
const unit = await page.evaluate(() => {
  const { mosaic, stitcher } = window.largepic;
  const t = mosaic.tiles[2];
  return { ok: stitcher.conflictAt(t.feat, t.x, t.y), shifted: stitcher.conflictAt(t.feat, t.x + 70, t.y + 40) };
});
check(unit.ok === null, '正しい位置では矛盾と判定されない');
check(unit.shifted && unit.shifted.score < 0.45, `ずれた位置は矛盾と判定される (一致度 ${unit.shifted ? unit.shifted.score.toFixed(2) : '-'})`);

// 2) 取り込み中に矛盾を見つけたら止まる（判定のしきい値を上げて、確実に矛盾と判定させる）
await page.evaluate(() => { window.largepic.mosaic.clear(); window.largepic.settings.conflictBelow = 1.01; });
const C = [];
for (let k = 0; k < 24; k++) C.push([500 + k * 20, 600, 0]);
for (let k = 0; k < 14; k++) C.push([960, 600 + k * 16, 0]);
for (let k = 0; k < 24; k++) C.push([960 - k * 20, 824, 0]);
const vidC = await makeVideo('vidC', C);
await page.setInputFiles('#fileVideo', vidC);
await page.waitForSelector('#dlgCrop[open]', { timeout: 20000 });
await page.click('#dlgCrop [data-ok]');
await waitConflict();
const body = await page.evaluate(() => document.querySelector('#cfBody').textContent);
console.log(body);
check(/食い違い/.test(body), '矛盾を見つけて止まり、確認ダイアログが出る');
check(await open('#dlgProgress'), '取り込みは一時停止中（ダイアログの選択待ち）');
const n1 = await tiles();
await page.click('#cfUndo3');
await page.waitForFunction(() => !document.querySelector('#dlgProgress').open, null, { timeout: 60000 });
const n2 = await tiles();
check(n2 === n1 - Math.min(3, n1), `「直前の3枚を取り消して終了」で戻る (${n1} → ${n2})`);
check(!(await open('#dlgConflict')), 'ダイアログが閉じて取り込みが終了している');

// 3) 戻すダイアログ：1枚ずつ／取り込み単位
await page.evaluate(() => { window.largepic.settings.conflictBelow = 0.45; });
await importVideo(vidC);   // 通常のしきい値で取り込み直す
const n5 = await tiles();
check(n5 >= 6, `通常のしきい値では矛盾せず取り込める (${n5}枚)`);
const diag = await page.evaluate(() => JSON.parse(JSON.stringify(window.largepic.diagnostics())));
check(diag.version && diag.lastImport.method && diag.mosaic.list.length === n5 && diag.lastImport.stats.added > 0, `診断情報に取り込みの記録とタイルの一覧が入る (${diag.lastImport.method}, ${diag.mosaic.list.length}枚)`);
await page.click('#btnUndo');
console.log(await page.evaluate(() => document.querySelector('#undoInfo').textContent));
await page.click('#undo1');
check((await tiles()) === n5 - 1, '「最後の1枚を取り消す」');
await page.click('#btnUndo'); await page.click('#undo5');
check((await tiles()) === n5 - 6, '「最後の5枚を取り消す」');
await page.click('#btnUndo'); await page.click('#undoBatch');
check((await tiles()) === 0, '「直近の取り込みをすべて取り消す」で取り込み前に戻る');

// 4) 「無視して続ける」を選び続けると、最後まで取り込める
await page.evaluate(() => { window.largepic.settings.conflictBelow = 1.01; });
await page.setInputFiles('#fileVideo', vidC);
await page.waitForSelector('#dlgCrop[open]', { timeout: 20000 });
await page.click('#dlgCrop [data-ok]');
let ignored = 0;
for (;;) {
  await page.waitForFunction(() => document.querySelector('#dlgConflict').open || !document.querySelector('#dlgProgress').open, null, { timeout: 120000, polling: 200 });
  if (!(await open('#dlgConflict'))) break;
  await page.click('#cfIgnore'); ignored++;
}
const n4 = await tiles();
check(ignored >= 1 && n4 >= 6, `「無視して続ける」で最後まで取り込める (無視 ${ignored}回, ${n4}枚)`);
await browser.close(); server.close(); process.exit(fail?1:0);
