// 画像がつながらなくなったら止まり、一つ前に戻して保存へ進めること
// node test/e2e-lost.mjs
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
const tiles = () => page.evaluate(() => window.largepic.mosaic.tiles.length);
const open = (sel) => page.evaluate((s) => document.querySelector(s).open, sel);
const waitLost = async () => {
  await page.waitForFunction(() => document.querySelector('#dlgLost').open || !document.querySelector('#dlgProgress').open, null, { timeout: 120000, polling: 300 });
  if (!(await open('#dlgLost'))) throw new Error('見失いの警告が出なかった');
};
// 動画：最初は普通に東へ → 途中で、まったく別の場所の絵に切り替わる（取り込み済みの絵とつながらない）
const V = [];
for (let k = 0; k < 24; k++) V.push([500 + k * 20, 600]);
for (let k = 0; k < 24; k++) V.push([2000 + k * 20, 2100]);
const vid = await makeVideo('vidLost', V);
const start = async () => {
  await page.setInputFiles('#fileVideo', vid);
  await page.waitForSelector('#dlgCrop[open]', { timeout: 20000 });
  await page.click('#dlgCrop [data-ok]');
};

// 1) 「一つ前に戻して保存へ」
await page.evaluate(() => { window.largepic.mosaic.clear(); });
await start();
await waitLost();
const body = await page.evaluate(() => document.querySelector('#lsBody').textContent);
console.log(body);
check(/つながらなく/.test(body), 'つながらなくなったら止まり、確認ダイアログが出る');
check(await open('#dlgProgress'), '取り込みは一時停止中（選択待ち）');
const n1 = await tiles();
await page.click('#lsBack');
await page.waitForSelector('#dlgExport[open]', { timeout: 30000 });
const n2 = await tiles();
check(n2 === n1 - 1, `一つ前に戻る (${n1} → ${n2}枚)`);
check(await open('#dlgExport'), '保存の画面が開く');
check(!(await open('#dlgProgress')) && !(await open('#dlgLost')), '取り込みは終了している');
await page.click('#dlgExport [data-close]');

// 2) 「ここまでを残して保存へ」
await page.evaluate(() => { window.largepic.mosaic.clear(); });
await start();
await waitLost();
const m1 = await tiles();
await page.click('#lsSave');
await page.waitForSelector('#dlgExport[open]', { timeout: 30000 });
check((await tiles()) === m1, `残して保存へ（枚数は変わらない: ${m1}枚）`);
await page.click('#dlgExport [data-close]');

// 3) 「この取り込み分を取り消して終了」
await page.evaluate(() => { window.largepic.mosaic.clear(); });
await start();
await waitLost();
await page.click('#lsUndo');
await page.waitForFunction(() => !document.querySelector('#dlgProgress').open, null, { timeout: 30000 });
check((await tiles()) === 0, '取り込み分をすべて取り消して終了できる');
check(!(await open('#dlgExport')), '（この場合は保存の画面は開かない）');

// 4) 「続ける」を選び続けると最後まで進む
await page.evaluate(() => { window.largepic.mosaic.clear(); });
await start();
let cont = 0;
for (;;) {
  await page.waitForFunction(() => document.querySelector('#dlgLost').open || !document.querySelector('#dlgProgress').open, null, { timeout: 120000, polling: 200 });
  if (!(await open('#dlgLost'))) break;
  await page.click('#lsContinue'); cont++;
}
check(cont >= 1 && (await tiles()) >= 3, `「続ける」で最後まで進む（${cont}回選択、${await tiles()}枚）`);
await browser.close(); server.close(); process.exit(fail?1:0);
