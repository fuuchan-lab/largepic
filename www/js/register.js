// 画像位置合わせ（平行移動のみ）
// 位相限定相関で粗く候補を探し、正規化相互相関(NCC)で検証・高解像度で詰める。
// DOM に依存しないので Node でもテストできる。

// ---------- FFT ----------
function fft1d(re, im, n, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function fft2d(re, im, nx, ny, inverse) {
  const rr = new Float64Array(Math.max(nx, ny));
  const ii = new Float64Array(Math.max(nx, ny));
  for (let y = 0; y < ny; y++) {
    const o = y * nx;
    for (let x = 0; x < nx; x++) { rr[x] = re[o + x]; ii[x] = im[o + x]; }
    fft1d(rr, ii, nx, inverse);
    for (let x = 0; x < nx; x++) { re[o + x] = rr[x]; im[o + x] = ii[x]; }
  }
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) { rr[y] = re[y * nx + x]; ii[y] = im[y * nx + x]; }
    fft1d(rr, ii, ny, inverse);
    for (let y = 0; y < ny; y++) { re[y * nx + x] = rr[y]; im[y * nx + x] = ii[y]; }
  }
}

const nextPow2 = (v) => { let n = 1; while (n < v) n <<= 1; return n; };

// ---------- 画像ピラミッド ----------
// gray: Uint8Array / Uint8ClampedArray (w*h)
export function downscale(gray, w, h, tw, th) {
  const out = new Float32Array(tw * th);
  const sx = w / tw, sy = h / th;
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * sy), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * sy));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * sx), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * sx));
      let s = 0;
      for (let y = y0; y < y1; y++) {
        const o = y * w;
        for (let x = x0; x < x1; x++) s += gray[o + x];
      }
      out[ty * tw + tx] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function makeLevel(gray, w, h, scale) {
  if (scale >= 1) return { data: gray, w, h, scale: 1 };
  const lw = Math.max(8, Math.round(w * scale));
  const lh = Math.max(8, Math.round(h * scale));
  return { data: downscale(gray, w, h, lw, lh), w: lw, h: lh, scale: lw / w };
}

// scales: { coarse, mid }  （例: 最大辺 160px / 640px になる倍率）
export function makeFeatures(gray, w, h, scales) {
  return {
    w, h,
    coarse: makeLevel(gray, w, h, scales.coarse),
    mid: makeLevel(gray, w, h, scales.mid),
    full: { data: gray, w, h, scale: 1 },
    _fft: null,
  };
}

export function scalesFor(w, h) {
  const m = Math.max(w, h);
  return { coarse: Math.min(1, 160 / m), mid: Math.min(1, 640 / m) };
}

// 輝度を「エッジ強調+平均0」にしたテーパー付き画像をFFT
function coarseSpectrum(f, nx, ny) {
  const key = nx + 'x' + ny;
  if (f._fft && f._fft.key === key) return f._fft;
  const { data, w, h } = f.coarse;
  let mean = 0;
  for (let i = 0; i < w * h; i++) mean += data[i];
  mean /= w * h;
  const re = new Float64Array(nx * ny), im = new Float64Array(nx * ny);
  const tx = Math.max(2, Math.round(w * 0.1)), ty = Math.max(2, Math.round(h * 0.1));
  const tap = (i, n, t) => {
    if (i < t) return 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / t);
    if (i >= n - t) return 0.5 - 0.5 * Math.cos(Math.PI * (n - i - 0.5) / t);
    return 1;
  };
  const wx = new Float64Array(w);
  for (let x = 0; x < w; x++) wx[x] = tap(x, w, tx);
  for (let y = 0; y < h; y++) {
    const wy = tap(y, h, ty);
    for (let x = 0; x < w; x++) {
      re[y * nx + x] = (data[y * w + x] - mean) * wy * wx[x];
    }
  }
  fft2d(re, im, nx, ny, false);
  f._fft = { key, re, im };
  return f._fft;
}

// エッジ検出（Sobel）で平坦度を計算
function computeEdgeDensity(data, w, h, x0, y0, x1, y1, stride) {
  let edges = 0, count = 0;
  for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y += stride) {
    for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x += stride) {
      const o = y * w + x;
      const gx = Math.abs(data[o - w - 1] + 2 * data[o - 1] + data[o + w - 1]
                        - data[o - w + 1] - 2 * data[o + 1] - data[o + w + 1]);
      const gy = Math.abs(data[o - w - 1] + 2 * data[o - w] + data[o - w + 1]
                        - data[o + w - 1] - 2 * data[o + w] - data[o + w + 1]);
      if (gx + gy > 50) edges++;
      count++;
    }
  }
  return count > 0 ? edges / count : 0;
}

// ---------- NCC ----------
// b を a 座標の (dx,dy) に置いたときの重なり部分の正規化相互相関
export function ncc(A, B, dx, dy, stride = 1) {
  const x0 = Math.max(0, dx), y0 = Math.max(0, dy);
  const x1 = Math.min(A.w, dx + B.w), y1 = Math.min(A.h, dy + B.h);
  if (x1 - x0 < 4 || y1 - y0 < 4) return { score: -1, overlap: 0 };
  const a = A.data, b = B.data, aw = A.w, bw = B.w;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y += stride) {
    const ao = y * aw, bo = (y - dy) * bw - dx;
    for (let x = x0; x < x1; x += stride) {
      const va = a[ao + x], vb = b[bo + x];
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
      n++;
    }
  }
  const overlap = ((x1 - x0) * (y1 - y0)) / Math.min(A.w * A.h, B.w * B.h);
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  if (va <= 1e-6 * n || vb <= 1e-6 * n) return { score: 0, overlap, raw: 0, texture: 0 };

  // 平坦性チェック改善：エッジ密度を考慮
  let flatScore = Math.min(1, Math.sqrt(Math.min(va, vb) / n) / 2.5);
  const edgeA = computeEdgeDensity(a, A.w, A.h, x0, y0, x1, y1, stride);
  const edgeB = computeEdgeDensity(b, B.w, B.h, x0 - dx, y0 - dy, x1 - dx, y1 - dy, stride);
  if (edgeA > 0.05 || edgeB > 0.05) flatScore = Math.min(1, flatScore + 0.3);

  const raw = (sab - sa * sb / n) / Math.sqrt(va * vb);
  // raw: 平坦さの補正をしない純粋な相関 ／ texture: 重なり部分の模様の強さ（標準偏差）
  return { score: raw * flatScore, overlap, raw, texture: Math.sqrt(Math.min(va, vb) / n) };
}

function strideFor(area) {
  return area > 400000 ? 3 : area > 100000 ? 2 : 1;
}

function searchLocal(A, B, cx, cy, r, minOverlap, stride, step = 1) {
  let best = null;
  const s = stride || strideFor(Math.min(A.w * A.h, B.w * B.h));
  for (let dy = cy - r; dy <= cy + r; dy += step) {
    for (let dx = cx - r; dx <= cx + r; dx += step) {
      const res = ncc(A, B, dx, dy, s);
      if (res.overlap < minOverlap) continue;
      if (!best || res.score > best.score) best = { dx, dy, score: res.score, overlap: res.overlap };
    }
  }
  return best;
}

// 粗い解像度の (dx,dy) を高解像度まで詰める
function refine(a, b, cdx, cdy, minOverlap, fastScroll = false) {
  // mid
  const rm = a.mid.scale / a.coarse.scale;
  const midRadius = Math.ceil(rm) + (fastScroll ? 2 : 1);
  let best = searchLocal(a.mid, b.mid, Math.round(cdx * rm), Math.round(cdy * rm),
    midRadius, minOverlap * 0.8, 0, 2);
  if (!best) return null;
  best = searchLocal(a.mid, b.mid, best.dx, best.dy, 2, minOverlap * 0.8) || best;
  // full
  if (a.full && b.full && a.mid.scale < 1) {
    const rf = 1 / a.mid.scale;
    const cx = Math.round(best.dx * rf), cy = Math.round(best.dy * rf);
    const r = Math.ceil(rf) + (fastScroll ? 3 : 1);
    const big = Math.min(a.w * a.h, b.w * b.h);
    const s1 = big > 1500000 ? 4 : big > 400000 ? 3 : 2;
    let fb = searchLocal(a.full, b.full, cx, cy, r, minOverlap * 0.7, s1, 2);
    if (!fb) return null;
    fb = searchLocal(a.full, b.full, fb.dx, fb.dy, 1, minOverlap * 0.7, Math.max(1, s1 - 2)) || fb;
    return fb;
  }
  return best;
}

// 粗い解像度で候補を出して NCC で採点したリスト（良い順）
function coarseCandidates(a, b, opts) {
  const minOverlap = opts.minOverlap ?? 0.08;
  const A = a.coarse, B = b.coarse;
  const nx = nextPow2(A.w + B.w), ny = nextPow2(A.h + B.h);
  const fa = coarseSpectrum(a, nx, ny), fb = coarseSpectrum(b, nx, ny);
  const n = nx * ny;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // A * conj(B)
    const r = fa.re[i] * fb.re[i] + fa.im[i] * fb.im[i];
    const m = fa.im[i] * fb.re[i] - fa.re[i] * fb.im[i];
    const mag = Math.hypot(r, m) + 1e-9;
    re[i] = r / mag; im[i] = m / mag;
  }
  fft2d(re, im, nx, ny, true);

  // 上位ピーク
  const K = opts.candidates ?? 10;
  const peaks = [];
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = re[y * nx + x];
      if (peaks.length < K * 4 || v > peaks[peaks.length - 1].v) {
        peaks.push({ x, y, v });
        peaks.sort((p, q) => q.v - p.v);
        if (peaks.length > K * 4) peaks.pop();
      }
    }
  }
  const cands = [];
  for (const p of peaks) {
    const dx = p.x >= nx / 2 ? p.x - nx : p.x;
    const dy = p.y >= ny / 2 ? p.y - ny : p.y;
    if (cands.some((c) => Math.abs(c.dx - dx) <= 2 && Math.abs(c.dy - dy) <= 2)) continue;
    cands.push({ dx, dy });
    if (cands.length >= K) break;
  }
  if (opts.hint) {
    cands.push({ dx: Math.round(opts.hint.dx * A.scale), dy: Math.round(opts.hint.dy * A.scale) });
  }
  // 粗い解像度で NCC 検証（±1 の近傍も見る）
  const scored = [];
  for (const c of cands) {
    const r = searchLocal(A, B, c.dx, c.dy, 1, minOverlap, 1);
    if (r) scored.push(r);
  }
  for (const r of scored) r.adj = adjusted(r, opts.prior, A);
  scored.sort((p, q) => q.adj - p.adj);
  return scored;
}

// 候補の総合点：重なりが小さい一致は割り引き、直前の動き（prior）から外れる候補は減点する。
// 線状の特徴（海岸線など）だけが映っていると、線に沿ってずらしても高い値が出てしまい
// （開口問題）、重なりの小さい別の場所に合ってしまうのを防ぐ。
function adjusted(r, prior, L) {
  let v = r.score * (0.7 + 0.3 * Math.min(1, r.overlap / 0.5));
  if (prior) {
    const dx = r.dx - prior.dx * L.scale, dy = r.dy - prior.dy * L.scale;
    v -= 0.25 * Math.min(1, Math.hypot(dx, dy) / (0.5 * Math.min(L.w, L.h)));
  }
  return v;
}

// 粗い解像度だけで素早く当たりをつける（多数のタイルから探すとき用）
export function coarseMatch(a, b, opts = {}) {
  const s = coarseCandidates(a, b, { ...opts, candidates: opts.candidates ?? 6 });
  return s[0] || null;
}

// a に対する b の位置 (dx,dy) を推定する
// opts: { minOverlap, hint:{dx,dy} (フル解像度), candidates, fastScroll }
export function register(a, b, opts = {}) {
  const minOverlap = opts.minOverlap ?? 0.08;
  const scored = coarseCandidates(a, b, opts);
  let best = null, bestAdj = -Infinity;
  const L = { scale: 1, w: a.w, h: a.h };
  for (const c of scored.slice(0, 3)) {
    const r = refine(a, b, c.dx, c.dy, minOverlap, opts.fastScroll);
    if (!r) continue;
    const adj = adjusted(r, opts.prior, L);
    if (adj > bestAdj) { best = r; bestAdj = adj; }
    if (best && best.score > 0.85 && best.overlap >= 0.5) break;
  }
  return best; // {dx, dy, score, overlap} | null
}

// 現在位置付近だけを探す（手動配置後のスナップ用）
export function registerNear(a, b, dx, dy, radiusFull, opts = {}) {
  const minOverlap = opts.minOverlap ?? 0.03;
  const s = a.coarse.scale;
  const r = Math.max(2, Math.ceil(radiusFull * s));
  const c = searchLocal(a.coarse, b.coarse, Math.round(dx * s), Math.round(dy * s), r, minOverlap, 1);
  if (!c) return null;
  return refine(a, b, c.dx, c.dy, minOverlap);
}

// ---------- 回転・拡大率の検出（Fourier–Mellin）----------
// 平行移動だけでは合わないとき、2枚のあいだに回転や拡大率の違いがないかを調べる。
// 振幅スペクトルを対数極座標にすると、回転と拡大が「平行移動」になるので位相相関で求められる。
// 候補は、実際に画像を変形して位置合わせ（NCC）できるか確認してから採用する。
const FM_N = 256, FM_A = 128, FM_R = 128;
const FM_RMIN = 6, FM_RMAX = FM_N / 2 - 2;
const FM_LOGK = Math.log(FM_RMAX / FM_RMIN) / (FM_R - 1);

function logPolar(f) {
  if (f._lp) return f._lp;
  const { data, w, h } = f.coarse;
  const N = FM_N;
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  let mean = 0;
  for (let i = 0; i < w * h; i++) mean += data[i];
  mean /= w * h;
  const tx = Math.max(2, Math.round(w * 0.15)), ty = Math.max(2, Math.round(h * 0.15));
  const tap = (i, n, t) => (i < t ? 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / t)
    : i >= n - t ? 0.5 - 0.5 * Math.cos(Math.PI * (n - i - 0.5) / t) : 1);
  const ox = (N - w) >> 1, oy = (N - h) >> 1;
  for (let y = 0; y < h; y++) {
    const wy = tap(y, h, ty);
    for (let x = 0; x < w; x++) re[(y + oy) * N + x + ox] = (data[y * w + x] - mean) * wy * tap(x, w, tx);
  }
  fft2d(re, im, N, N, false);
  const mag = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      mag[((y + N / 2) % N) * N + (x + N / 2) % N] = Math.log(1 + Math.hypot(re[i], im[i]));
    }
  }
  const out = new Float64Array(FM_A * FM_R);
  const cx = N / 2, cy = N / 2;
  for (let a = 0; a < FM_A; a++) {
    const th = (a * Math.PI) / FM_A, c = Math.cos(th), s = Math.sin(th);
    let m = 0;
    for (let r = 0; r < FM_R; r++) {
      const rr = FM_RMIN * Math.exp(r * FM_LOGK);
      const x = cx + rr * c, y = cy + rr * s;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const v = mag[y0 * N + x0] * (1 - fx) * (1 - fy) + mag[y0 * N + x0 + 1] * fx * (1 - fy)
        + mag[(y0 + 1) * N + x0] * (1 - fx) * fy + mag[(y0 + 1) * N + x0 + 1] * fx * fy;
      out[a * FM_R + r] = v;
      m += v;
    }
    // 角度ごとの平均を引いて、低周波の偏りを除く
    m /= FM_R;
    for (let r = 0; r < FM_R; r++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * (r + 0.5)) / FM_R);
      out[a * FM_R + r] = (out[a * FM_R + r] - m) * win;
    }
  }
  f._lp = out;
  return out;
}

// 画像を中心まわりに phi (rad) 回転し k 倍にした画像（同じ大きさ、はみ出しは平均値）
function warpGray(img, phi, k) {
  const { data, w, h } = img;
  let mean = 0;
  for (let i = 0; i < w * h; i++) mean += data[i];
  mean /= w * h;
  const out = new Float32Array(w * h);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const c = Math.cos(phi), s = Math.sin(phi);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / k, dy = (y - cy) / k;
      const sx = c * dx + s * dy + cx, sy = -s * dx + c * dy + cy;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) { out[y * w + x] = mean; continue; }
      const fx = sx - x0, fy = sy - y0, o = y0 * w + x0;
      out[y * w + x] = data[o] * (1 - fx) * (1 - fy) + data[o + 1] * fx * (1 - fy)
        + data[o + w] * (1 - fx) * fy + data[o + w + 1] * fx * fy;
    }
  }
  return { data: out, w, h, scale: img.scale };
}

// b が a に対して回転・拡大縮小していないかを調べる。
// 戻り値: { angle: 度（b を a に重ねるために回す角。-180〜180）, scale: b を a に重ねるための倍率, score } か null
//   scale < 1 … b のほうが拡大されている（ズームインした）／ scale > 1 … 縮小されている
// opts.minAngle (度) / opts.minScale (比率の差) 未満の違いは「なし」として null を返す
// 模様の豊かさ：粗い画像で勾配が大きい画素の割合（海や空白が多いと小さい）
export function richness(f) {
  if (f._rich != null) return f._rich;
  const { data, w, h } = f.coarse;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = y * w + x;
      if (Math.abs(data[o + 1] - data[o - 1]) + Math.abs(data[o + w] - data[o - w]) > 14) n++;
    }
  }
  return (f._rich = n / ((w - 2) * (h - 2)));
}

export function diagnoseTransform(a, b, opts = {}) {
  // 模様の少ない画像（海など）では回転・拡大の推定が偶然の一致になりやすいので、診断しない
  const minRich = opts.minRichness ?? 0.05;
  if (richness(a) < minRich || richness(b) < minRich) return null;
  const minAngle = opts.minAngle ?? 3, minScale = opts.minScale ?? 0.04;
  const la = logPolar(a), lb = logPolar(b);
  const re = new Float64Array(FM_A * FM_R), im = new Float64Array(FM_A * FM_R);
  {
    const ar = Float64Array.from(la), ai = new Float64Array(la.length);
    const br = Float64Array.from(lb), bi = new Float64Array(lb.length);
    fft2d(ar, ai, FM_R, FM_A, false);
    fft2d(br, bi, FM_R, FM_A, false);
    for (let i = 0; i < re.length; i++) {
      const r = ar[i] * br[i] + ai[i] * bi[i], m = ai[i] * br[i] - ar[i] * bi[i];
      const mag = Math.hypot(r, m) + 1e-9;
      re[i] = r / mag; im[i] = m / mag;
    }
    fft2d(re, im, FM_R, FM_A, true);
  }
  // 上位ピークを何本か候補にする
  const peaks = [];
  for (let y = 0; y < FM_A; y++) {
    for (let x = 0; x < FM_R; x++) {
      const v = re[y * FM_R + x];
      if (peaks.length < 12 || v > peaks[peaks.length - 1].v) {
        peaks.push({ x, y, v });
        peaks.sort((p, q) => q.v - p.v);
        if (peaks.length > 12) peaks.pop();
      }
    }
  }
  const tried = new Set();
  const plain = coarseMatch(a, b, { candidates: 4 });
  if (plain && plain.score >= 0.6) return null; // 平行移動だけで十分合う
  let best = null;
  const A = a.coarse, B = b.coarse;
  for (const p of peaks.slice(0, 6)) {
    if (best && best.score >= 0.7) break;
    const sa = p.y >= FM_A / 2 ? p.y - FM_A : p.y;       // 角度方向（周期 π）
    const sr = p.x >= FM_R / 2 ? p.x - FM_R : p.x;       // 対数半径方向
    const dth = (sa * Math.PI) / FM_A;
    const ls = sr * FM_LOGK;
    for (const sg of [1, -1]) {
      for (const inv of [1, -1]) {
        for (const flip of [0, Math.PI]) {
          const phi = sg * dth + flip, k = Math.exp(inv * ls);
          const key = `${Math.round(phi * 40)}_${Math.round(Math.log(k) * 100)}`;
          if (tried.has(key)) continue;
          tried.add(key);
          const warped = { w: B.w, h: B.h, _fft: null, coarse: warpGray(B, phi, k) };
          const r = coarseMatch(a, warped, { candidates: 3 });
          if (r && (!best || r.score > best.score)) {
            let ang = (phi * 180) / Math.PI;
            ang = ((ang + 180) % 360 + 360) % 360 - 180;
            best = { angle: ang, scale: k, score: r.score };
          }
        }
      }
    }
  }
  if (!best) return null;
  if (plain && plain.score >= best.score * 0.9) return null; // 回転・拡大なしでも同じくらい合う
  const significant = Math.abs(best.angle) >= minAngle || Math.abs(Math.log(best.scale)) >= Math.log(1 + minScale);
  // 偽陽性を避けるため、変形後にしっかり合う（0.6 以上）ものだけ採用する。
  // 模様の少ない海などでは偶然に近い値が出るので、平行移動で合う場合との差も求める。
  const margin = best.score - (plain ? Math.max(0, plain.score) : 0);
  return significant && best.score >= (opts.minScore ?? 0.6) && margin >= 0.15 ? best : null;
}
