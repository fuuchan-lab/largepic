// 動画取り込みの速さの計測: node test/bench-import.mjs
// 1170×2532 の画面収録（9 秒・横→縦にスクロール）を作って取り込み、段階ごとの時間を表示する。
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'www');
const tmp = path.join(process.env.TMPDIR || os.tmpdir(), 'largepic-bench');
await mkdir(tmp, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/json' };
const server = createServer(async (req, res) => { try { const p = path.join(root, new URL(req.url, 'http://x').pathname); const f = p.endsWith('/') ? p + 'index.html' : p; res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(await readFile(f)); } catch { res.writeHead(404); res.end(); } }).listen(0);
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 420, height: 860 } });
page.on('console', (m) => { if (m.text().startsWith('解析(')) console.log('  ', m.text()); });
await page.goto(`http://localhost:${server.address().port}/`);
const video = path.join(tmp, 'rec.webm');
if (!existsSync(video)) {
  await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 6000; const g = c.getContext('2d');
    let s = 9; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    g.fillStyle = '#eef0e6'; g.fillRect(0, 0, 6000, 6000);
    for (let i = 0; i < 500; i++) { g.fillStyle = `hsl(${90 + r() * 120},40%,${70 + r() * 15}%)`; g.fillRect(r() * 6000, r() * 6000, 60 + r() * 500, 60 + r() * 500); }
    g.strokeStyle = '#fff'; g.lineCap = 'round';
    for (let i = 0; i < 120; i++) { g.lineWidth = 6 + r() * 20; g.beginPath(); g.moveTo(r() * 6000, r() * 6000); g.bezierCurveTo(r() * 6000, r() * 6000, r() * 6000, r() * 6000, r() * 6000, r() * 6000); g.stroke(); }
    g.fillStyle = '#334'; g.font = '34px sans-serif'; for (let i = 0; i < 1500; i++) g.fillText('地点' + i, r() * 6000, r() * 6000);
    window.__f = (x, y) => { const o = document.createElement('canvas'); o.width = 1170; o.height = 2532; o.getContext('2d').drawImage(c, x, y, 1170, 2532, 0, 0, 1170, 2532); return o.toDataURL('image/png'); };
  });
  let x = 300, y = 300;
  for (let k = 0; k < 90; k++) {
    if (k < 45) x += 50; else y += 60;
    const d = await page.evaluate(([x, y]) => window.__f(x, y), [x, y]);
    await writeFile(`${tmp}/f${String(k).padStart(4, '0')}.png`, Buffer.from(d.split(',')[1], 'base64'));
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '10', '-i', `${tmp}/f%04d.png`, '-c:v', 'libvpx', '-b:v', '8M', '-pix_fmt', 'yuv420p', video]);
}
await page.reload();
const t0 = Date.now();
await page.setInputFiles('#fileVideo', video);
await page.waitForSelector('#dlgCrop[open]');
await page.click('#dlgCrop [data-ok]');
await page.waitForFunction(() => !document.querySelector('#dlgProgress').open, null, { timeout: 900000, polling: 300 });
const r = await page.evaluate(() => ({ n: window.largepic.mosaic.tiles.length, bb: window.largepic.mosaic.bbox(), perf: window.largepic.importLog.perf, stats: window.largepic.importLog.stats }));
console.log(`合計 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`, JSON.stringify({ tiles: r.n, bbox: r.bb }), JSON.stringify(r.stats));
for (const [k, v] of Object.entries(r.perf).sort((a, b) => b[1].ms - a[1].ms)) console.log(k.padEnd(20), String(v.ms).padStart(7) + 'ms', 'n=' + v.n, 'avg=' + v.avg);
await b.close(); server.close();
