// 画面の真ん中の動かない物（ポインター・キャラクター）を記録しない: node test/e2e-mask.mjs
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
    const d = await page.evaluate(([x, y]) => window.__shotS(x, y), pts[k]);
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
// 画面の真ん中（切り抜き範囲の中心）に、地図が動いても動かないキャラクター（赤い丸＋白い輪）を重ねる
await page.evaluate(() => {
  window.__shotS = (x, y) => {
    const w = 390, h = 844, o = document.createElement('canvas'); o.width = w; o.height = h;
    const q = o.getContext('2d');
    q.drawImage(window.__world, x, y, w, h, 0, 0, w, h);
    q.fillStyle = '#fff'; q.fillRect(0, 0, w, 100); q.fillStyle = '#888'; q.fillRect(20, 40, w - 40, 44);
    q.fillStyle = '#fafafa'; q.fillRect(0, h - 100, w, 100); q.fillStyle = '#39f'; q.fillRect(30, h - 80, 60, 50);
    const cx = w / 2, cy = 110 + (h * 0.73) / 2;      // 切り抜き範囲（上13%・下14%を除く）の中心
    q.fillStyle = '#fff'; q.beginPath(); q.arc(cx, cy, 30, 0, 7); q.fill();
    q.fillStyle = '#e00'; q.beginPath(); q.arc(cx, cy, 22, 0, 7); q.fill();
    q.fillStyle = '#000'; q.fillRect(cx - 4, cy - 12, 8, 24);
    return o.toDataURL('image/png');
  };
});
const P = [];
for (let k = 0; k < 40; k++) P.push([500 + k * 18, 600]);
for (let k = 0; k < 24; k++) P.push([500 + 39 * 18, 600 + k * 16]);
const vid = await makeVideo('vidMask', P);
const redCount = () => page.evaluate(async () => {
  const c = await window.largepic.mosaic.exportCanvas({ scale: 1 });
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] < 60 && d[i + 2] < 60 && d[i + 3] > 200) n++;
  return n;
});
const startImport = async () => {
  await page.setInputFiles('#fileVideo', vid);
  await page.waitForSelector('#dlgCrop[open]', { timeout: 20000 });
};
const finishImport = async () => {
  await page.click('#dlgCrop [data-ok]');
  await page.waitForSelector('#dlgProgress[open]', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#dlgProgress').open, null, { timeout: 180000, polling: 300 });
};

// 1) 比較用：マスクなしで取り込むと、キャラクターが画像に写り込む
await page.evaluate(() => window.largepic.mosaic.clear());
await startImport(); await finishImport();
const redNoMask = await redCount();
check(redNoMask > 500, `マスクなしだと、キャラクターが画像に残る（赤い画素 ${redNoMask}）`);

// 2) 自動で見つける → 取り込み
await page.evaluate(() => window.largepic.mosaic.clear());
await startImport();
await page.check('#maskOn');
await page.waitForSelector('#maskDetect:not([hidden])');
await page.click('#maskDetect');
await page.waitForFunction(() => !document.querySelector('#maskDetect').disabled, null, { timeout: 60000 });
const msg = await page.evaluate(() => document.querySelector('#maskMsg').textContent);
console.log(msg);
check(/見つかりました/.test(msg), '動かない物を自動で見つけられる');
await page.screenshot({ path: path.join(tmp, 'mask-dialog.png') });
await finishImport();
const mk = await page.evaluate(() => window.largepic.settings.mask);
console.log(JSON.stringify(mk));
check(mk.on && Math.abs(mk.cx - 0.5) < 0.06 && Math.abs(mk.cy - 0.5) < 0.06, `見つけた位置が真ん中 (cx=${mk.cx.toFixed(2)}, cy=${mk.cy.toFixed(2)})`);
check(mk.rw * 390 >= 28 && mk.rw * 390 <= 90, `範囲が物を覆い、広すぎない（半径 ${(mk.rw * 390).toFixed(0)}px）`);
const redMask = await redCount();
check(redMask === 0, `マスクありだと、キャラクターが画像に残らない（赤い画素 ${redMask}）`);
const info = await page.evaluate(() => {
  const { mosaic } = window.largepic;
  // すべてのタイルについて、物が写っていた位置（タイルの中心）が、ほかのタイルで覆われているか
  const holes = mosaic.tiles.filter((t) => !mosaic.covers(t.x + t.mask.cx, t.y + t.mask.cy)).length;
  return { n: mosaic.tiles.length, masked: mosaic.tiles.filter((t) => t.mask).length, holes, bb: mosaic.bbox() };
});
console.log(JSON.stringify(info));
check(info.masked === info.n && info.n >= 6, `すべてのタイルに記録しない領域がある (${info.masked}/${info.n}枚)`);
check(info.holes === 0, `物に隠れていた部分は、動いたあとの絵で埋まっている（埋まっていない所 ${info.holes}か所）`);
// 位置合わせに影響しない：全体の大きさが正しい（東へ 39*18、南へ 23*16、1フレーム 390×616）
check(Math.abs(info.bb.w - (39 * 18 + 390)) <= 20 && Math.abs(info.bb.h - (23 * 16 + 616)) <= 20, `全体の大きさが正しい (${info.bb.w}×${info.bb.h})`);

// 3) 取り込んだ地図が元の地図と一致する（キャラクターの場所も、本物の地図になっている）
const diff = await page.evaluate(async (cands) => {
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
  return best;
}, P);
check(diff < 6, `元の地図との平均差が小さい（${diff.toFixed(2)}）。物の下にあった地図も写っている`);

// 4) 手で動かす・大きさを変える（赤い範囲をドラッグ）
await page.evaluate(() => window.largepic.mosaic.clear());
await startImport();
const geo = await page.evaluate(() => {
  const r = document.querySelector('#dlgCrop canvas').getBoundingClientRect();
  const m = window.largepic.settings.mask;
  return { l: r.left, t: r.top, w: r.width, h: r.height, cx: m.cx, cy: m.cy, rw: m.rw, rh: m.rh };
});
const ctr = { x: geo.l + geo.cx * geo.w, y: geo.t + (0.13 + geo.cy * 0.73) * geo.h };
await page.mouse.move(ctr.x, ctr.y); await page.mouse.down(); await page.mouse.move(ctr.x + 40, ctr.y + 30, { steps: 6 }); await page.mouse.up();
// 右下の●で大きさを変える
const knob = { x: geo.l + (geo.cx + geo.rw) * geo.w + 40, y: geo.t + (0.13 + (geo.cy + geo.rh) * 0.73) * geo.h + 30 };
await page.mouse.move(knob.x, knob.y); await page.mouse.down(); await page.mouse.move(knob.x + 20, knob.y + 12, { steps: 6 }); await page.mouse.up();
await page.click('#maskShape [data-v=rect]');
await finishImport();
const mk2 = await page.evaluate(() => window.largepic.settings.mask);
console.log(JSON.stringify(mk2));
check(mk2.cx > mk.cx + 0.05 && mk2.cy > mk.cy + 0.03, `ドラッグで位置を動かせる (cx ${mk.cx.toFixed(2)} → ${mk2.cx.toFixed(2)})`);
check(mk2.rw > mk.rw + 0.02, `●で大きさを変えられる (半径 ${(mk.rw * 390).toFixed(0)} → ${(mk2.rw * 390).toFixed(0)}px)`);
check(mk2.shape === 'rect', '丸／四角を切り替えられる');
await browser.close(); server.close(); process.exit(fail?1:0);
