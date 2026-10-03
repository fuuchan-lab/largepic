// node test/transform.test.mjs  — 回転・拡大率の検出
import { makeFeatures, diagnoseTransform, register, scalesFor } from '../www/js/register.js';

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }
const W = 4000, H = 4000;
const world = (() => {
  const r = rng(11); const img = new Uint8Array(W * H).fill(235);
  const rect = (x, y, w, h, v) => { for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) img[yy * W + xx] = v; };
  for (let i = 0; i < 700; i++) rect((r() * W) | 0, (r() * H) | 0, (20 + r() * 220) | 0, (20 + r() * 220) | 0, (140 + r() * 90) | 0);
  for (let i = 0; i < 160; i++) { if (r() < 0.5) rect(0, (r() * H) | 0, W, (3 + r() * 10) | 0, 255); else rect((r() * W) | 0, 0, (3 + r() * 10) | 0, H, 255); }
  for (let i = 0; i < 4000; i++) rect((r() * W) | 0, (r() * H) | 0, (4 + r() * 30) | 0, (2 + r() * 6) | 0, (40 + r() * 60) | 0);
  return img;
})();
// 世界の (cx,cy) を中心に、回転 deg・拡大 k で切り出した w×h のフレーム
function frame(cx, cy, w, h, deg = 0, k = 1) {
  const out = new Uint8Array(w * h), c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x - w / 2) / k, dy = (y - h / 2) / k;
    const sx = Math.round(cx + c * dx - s * dy), sy = Math.round(cy + s * dx + c * dy);
    out[y * w + x] = sx >= 0 && sy >= 0 && sx < W && sy < H ? world[sy * W + sx] : 235;
  }
  return out;
}
const w = 590, h = 1000, sc = scalesFor(w, h);
const feat = (g) => makeFeatures(g, w, h, sc);
let fail = 0;
const base = feat(frame(2000, 2000, w, h));
const cases = [
  ['平行移動のみ（回転・拡大なし）', frame(2200, 2500, w, h), null],
  ['回転 12°', frame(2150, 2300, w, h, 12), { angle: 12 }],
  ['回転 -25°', frame(2100, 2200, w, h, -25), { angle: -25 }],
  ['回転 90°', frame(2000, 2300, w, h, 90), { angle: 90 }],
  ['拡大 1.3倍', frame(2100, 2200, w, h, 0, 1.3), { scale: 1.3 }],
  ['縮小 0.75倍', frame(2100, 2200, w, h, 0, 0.75), { scale: 0.75 }],
  ['回転 8° ＋ 拡大 1.15倍', frame(2150, 2250, w, h, 8, 1.15), { angle: 8, scale: 1.15 }],
];
for (const [name, g, exp] of cases) {
  const fb = feat(g);
  const t0 = performance.now();
  const r = diagnoseTransform(base, fb);
  const ms = (performance.now() - t0).toFixed(0);
  let ok;
  if (!exp) ok = r === null;
  else {
    ok = !!r;
    // 向きは b を a に重ねる角・倍率で返るので、符号と逆数は問わず大きさで比べる
    if (ok && exp.angle != null) ok = Math.abs(Math.abs(r.angle) - Math.abs(exp.angle)) <= 3;
    if (ok && exp.scale != null) { const e = Math.abs(Math.log(exp.scale)), g2 = Math.abs(Math.log(r.scale)); ok = Math.abs(e - g2) < 0.06; }
  }
  if (!ok) fail++;
  console.log(ok ? 'OK ' : 'NG ', name, r ? `→ 角度 ${r.angle.toFixed(1)}° 倍率 ${r.scale.toFixed(2)} (score ${r.score.toFixed(2)})` : '→ 検出なし', `${ms}ms`);
}
// 重なりの少ない平行移動（誤検出しないこと）
{
  const r = diagnoseTransform(base, feat(frame(2000, 3050, w, h)));
  const ok = r === null; if (!ok) fail++;
  console.log(ok ? 'OK ' : 'NG ', '重なり約5%の平行移動で誤検出しない', r ? JSON.stringify(r) : '');
}
// 無関係な場所（誤検出しないこと）
{
  const r = diagnoseTransform(base, feat(frame(500, 500, w, h)));
  const ok = r === null; if (!ok) fail++;
  console.log(ok ? 'OK ' : 'NG ', '無関係な場所で誤検出しない', r ? JSON.stringify(r) : '');
}
if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all passed');
