// 地図の回転・拡大率の変化を検出して停止し、警告を出すこと
// node test/e2e-transform.mjs
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
    const d = await page.evaluate(([x, y, deg, k]) => window.__shotT(x, y, deg, k), pts[k]);
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
// 回転・拡大して撮ったフレームを作る（中心 (x+195, y+422) まわり）
await page.evaluate(() => {
  window.__shotT = (x, y, deg = 0, k = 1) => {
    const w = 390, h = 844, o = document.createElement('canvas'); o.width = w; o.height = h;
    const q = o.getContext('2d');
    q.translate(w / 2, h / 2); q.rotate(deg * Math.PI / 180); q.scale(k, k); q.translate(-w / 2 - x, -h / 2 - y);
    q.drawImage(window.__world, 0, 0);
    q.setTransform(1, 0, 0, 1, 0, 0);
    q.fillStyle = '#fff'; q.fillRect(0, 0, w, 100); q.fillStyle = '#888'; q.fillRect(20, 40, w - 40, 44);
    q.fillStyle = '#fafafa'; q.fillRect(0, h - 100, w, 100); q.fillStyle = '#39f'; q.fillRect(30, h - 80, 60, 50);
    return o.toDataURL('image/png');
  };
});
const warnOpen = () => page.evaluate(() => document.querySelector('#dlgWarn').open);
const warnText = () => page.evaluate(() => document.querySelector('#dlgWarn').innerText);
const tiles = () => page.evaluate(() => window.largepic.mosaic.tiles.length);

// 1) 途中から地図が回転していく動画：回転前までは取り込み、回転したら停止して警告
await page.evaluate(() => { window.largepic.mosaic.clear(); });
const R = [];
for (let k = 0; k < 24; k++) R.push([500 + k * 25, 600, 0, 1]);
for (let k = 0; k < 30; k++) R.push([1100, 600 + k * 12, Math.min(40, k * 2.5), 1]);
await page.setInputFiles('#fileVideo', await makeVideo('vidRot', R));
await page.waitForSelector('#dlgCrop[open]', { timeout: 20000 });
await page.click('#dlgCrop [data-ok]');
// 回転を見つけたら「回転」の警告。見つけきれなくても、つながらなくなった時点で止まり、回転の可能性を知らせる
await page.waitForFunction(() => document.querySelector('#dlgWarn').open || document.querySelector('#dlgLost').open, null, { timeout: 120000, polling: 200 });
const viaLost = await page.evaluate(() => document.querySelector('#dlgLost').open);
if (viaLost) {
  const lt = await page.evaluate(() => document.querySelector('#lsBody').textContent);
  console.log(lt);
  check(/回転/.test(lt), '回転を確定できなくても、止まって「回転した可能性」を知らせる');
  await page.click('#lsSave');                       // ここまでを残して保存へ
  await page.waitForSelector('#dlgExport[open]', { timeout: 30000 });
  await page.click('#dlgExport [data-close]');
} else {
  check(await warnOpen(), '回転した地図で取り込みを停止し、警告ダイアログが出る');
  const t1 = await warnText(); console.log(t1.replace(/\n/g, ' / '));
  check(/回転/.test(t1), '警告に「回転」と書かれている');
  await page.click('#warnOk');
}
const nRot = await tiles();
check(nRot >= 3, `回転前までの分は取り込み済み (${nRot}枚)`);
const bbRot = await page.evaluate(() => window.largepic.mosaic.bbox());
check(bbRot.h < 800, `回転後の画像は取り込まれていない (高さ ${bbRot.h})`);

// 2) 追加動画の拡大率が違う：位置が分からず停止して警告
await page.evaluate(() => { window.largepic.mosaic.clear(); });
const A = []; for (let k = 0; k < 30; k++) A.push([500 + k * 25, 600, 0, 1]);
await importVideo(await makeVideo('vidA2', A));
const nA = await tiles();
const Z = []; for (let k = 0; k < 30; k++) Z.push([700 + k * 10, 650, 0, 1.4]);
await importVideo(await makeVideo('vidZoom', Z));
check(await warnOpen(), '拡大率の違う追加動画で停止し、警告が出る');
const t2 = await warnText(); console.log(t2.replace(/\n/g, ' / '));
check(/拡大率/.test(t2), '警告に「拡大率」と書かれている');
check((await tiles()) === nA, '拡大率の違う動画からは何も取り込まない');
await page.click('#warnOk');

// 3) 同じ拡大率の追加動画では警告が出ない（誤検出なし）
const S = []; for (let k = 0; k < 20; k++) S.push([900 - k * 10, 640 + k * 15, 0, 1]);
for (let k = 0; k < 20; k++) S.push([700, 940 + k * 25, 0, 1]);
await importVideo(await makeVideo('vidSame', S));
check(!(await warnOpen()), '同じ拡大率・向きの追加動画では警告が出ない');
check((await tiles()) > nA, `追加動画は取り込まれる (${await tiles()}枚)`);
await browser.close(); server.close(); process.exit(fail?1:0);
