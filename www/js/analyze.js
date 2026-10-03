// 動画の事前解析：小さな画像で全体の動きをざっと追い、取り込むべきコマ（キーフレーム）だけを選ぶ。
// 本番の取り込み（高解像度の位置合わせ・タイル作成）は選んだコマだけに行うので速い。
//  1) 再生しながら（requestVideoFrameCallback）または一定間隔のシークで、縮小したコマを集める
//  2) 隣り合うコマの移動量を粗い解像度で求めて、軌跡（スクロールの経路）を作る
//  3) 経路上で、前のキーフレームと十分重なる範囲でできるだけ「止まっている」コマを選ぶ
import { cropRect, newCanvas } from './imageutil.js';
import { coarseMatch, scalesFor } from './register.js';

function waitSeeked(video, t, ms = 4000) {
  return new Promise((res) => {
    const done = () => { clearTimeout(to); video.removeEventListener('seeked', done); res(); };
    const to = setTimeout(done, ms);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

// 縮小して粗い特徴（register.js の coarse と同じ形）を作る
function makeGrabber(video, crop) {
  const r = cropRect(video.videoWidth, video.videoHeight, crop);
  const sc = scalesFor(r.w, r.h).coarse;
  const cw = Math.max(8, Math.round(r.w * sc)), ch = Math.max(8, Math.round(r.h * sc));
  const cv = newCanvas(cw, ch);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'medium';
  return {
    w: r.w, h: r.h, scale: cw / r.w,
    grab() {
      ctx.drawImage(video, r.sx, r.sy, r.w, r.h, 0, 0, cw, ch);
      const d = ctx.getImageData(0, 0, cw, ch).data;
      const g = new Float32Array(cw * ch);
      for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) / 256;
      return { w: r.w, h: r.h, _fft: null, coarse: { data: g, w: cw, h: ch, scale: cw / r.w } };
    },
  };
}

// 再生しながらコマを集める。コールバックが来ない環境では null を返す（呼び出し側でシークに切り替える）
async function collectByPlayback(video, grabber, { start, end, step, onProgress, isCancelled }) {
  if (!('requestVideoFrameCallback' in video)) return null;
  const samples = [];
  await waitSeeked(video, start);
  const prevRate = video.playbackRate;
  video.playbackRate = 2;
  try { await video.play(); } catch { video.playbackRate = prevRate; return null; }
  return new Promise((resolve) => {
    let last = -Infinity, lastCb = performance.now(), finished = false;
    const finish = (val) => {
      if (finished) return;
      finished = true;
      clearInterval(watch);
      video.pause();
      video.playbackRate = prevRate;
      resolve(val);
    };
    const watch = setInterval(() => {
      // 3 秒コールバックが来なければ諦める
      if (performance.now() - lastCb > 3000) finish(samples.length >= 3 ? samples : null);
    }, 500);
    const cb = (now, meta) => {
      if (finished) return;
      lastCb = performance.now();
      const t = meta.mediaTime;
      if (t - last >= step * 0.9 && t >= start - 1e-3 && t <= end + 1e-3) {
        samples.push({ t, feat: grabber.grab() });
        last = t;
        onProgress?.((t - start) / Math.max(0.01, end - start));
      }
      if (t >= end - 0.02 || video.ended || isCancelled?.()) return finish(samples);
      video.requestVideoFrameCallback(cb);
    };
    video.addEventListener('ended', () => finish(samples), { once: true });
    video.requestVideoFrameCallback(cb);
  });
}

async function collectBySeek(video, grabber, { start, end, step, onProgress, isCancelled }) {
  const samples = [];
  for (let t = start; t < end - 1e-3; t += step) {
    if (isCancelled?.()) break;
    await waitSeeked(video, t);
    samples.push({ t, feat: grabber.grab() });
    onProgress?.((t - start) / Math.max(0.01, end - start));
    await new Promise((r) => setTimeout(r, 0));
  }
  return samples;
}

// 解析：サンプルごとの位置（区間ごとの相対座標）を求める
// 戻り値: { samples: [{t, x, y, seg, speed}], w, h, brokenFraction }
export async function analyzeVideo(video, crop, opts) {
  const grabber = makeGrabber(video, crop);
  const step = opts.step ?? 0.1;
  const o = { ...opts, step };
  let raw = await collectByPlayback(video, grabber, o);
  let mode = 'playback';
  if (!raw || raw.length < 3) { raw = await collectBySeek(video, grabber, o); mode = 'seek'; }
  const sc = grabber.scale;
  const threshold = (opts.threshold ?? 0.55) * 0.85;
  const out = [];
  let seg = 0, x = 0, y = 0, prev = null, vel = null, broken = 0;
  for (let i = 0; i < raw.length; i++) {
    const { t, feat } = raw[i];
    if (opts.isCancelled?.()) break;
    if (!prev) {
      out.push({ t, x, y, seg, speed: Infinity });
    } else {
      const r = coarseMatch(prev.feat, feat, { hint: vel || undefined });
      if (r && r.score >= threshold) {
        const dx = r.dx / sc, dy = r.dy / sc;
        x += dx; y += dy; vel = { dx, dy };
        out.push({ t, x, y, seg, speed: Math.hypot(dx, dy) / Math.max(0.01, t - prev.t) });
      } else {
        // 追えなかった：ここから新しい区間（座標は区間ごとの相対）
        seg++; x = 0; y = 0; vel = null; broken++;
        out.push({ t, x, y, seg, speed: Infinity, newSeg: true });
      }
      prev.feat = null; // 使い終わったコマはメモリから外す
    }
    prev = raw[i];
    if (i % 6 === 5) await new Promise((r) => setTimeout(r, 0));
    opts.onAnalyze?.(i / raw.length);
  }
  return { samples: out, w: grabber.w, h: grabber.h, mode, brokenFraction: raw.length ? broken / raw.length : 1 };
}

const overlapFrac = (a, b, w, h) => {
  const ox = 1 - Math.abs(a.x - b.x) / w, oy = 1 - Math.abs(a.y - b.y) / h;
  return ox > 0 && oy > 0 ? Math.min(ox, oy) : 0;
};

const uncoveredBy = (s, keys, w, h) => {
  const n = 10;
  let miss = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const px = s.x + (i + 0.5) * w / n, py = s.y + (j + 0.5) * h / n;
      if (!keys.some((k) => px >= k.x && px < k.x + w && py >= k.y && py < k.y + h)) miss++;
    }
  }
  return miss / (n * n);
};

// 区間ごとに、前のキーフレームと minOverlap 以上重なる範囲で、できるだけ止まっているコマを選ぶ。
// 動かない区間（アプリ画面やホーム画面など、地図以外が映っている部分）は除く。
export function selectKeyframes(plan, { minOverlap = 0.4 } = {}) {
  const { samples, w, h } = plan;
  const segs = [];
  for (let i = 0; i < samples.length;) {
    let j = i;
    while (j + 1 < samples.length && samples[j + 1].seg === samples[i].seg) j++;
    segs.push(samples.slice(i, j + 1));
    i = j + 1;
  }
  const extent = (seg) => {
    const xs = seg.map((p) => p.x), ys = seg.map((p) => p.y);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };
  const small = Math.min(w, h) * 0.05;
  const moving = segs.filter((sg) => extent(sg) >= small);
  // 動く区間があれば、動かない区間は捨てる（全部動かないなら一番長いものだけ残す）
  const use = moving.length ? moving
    : [segs.reduce((a, b) => (b.length > a.length ? b : a), segs[0])];

  const keys = [];
  for (const seg of use) {
    const mine = [];
    // 区間の先頭：最初の数コマのうち止まっているもの
    let cur = 0;
    for (let k = 1; k < Math.min(4, seg.length); k++) if (seg[k].speed < seg[cur].speed) cur = k;
    mine.push({ ...seg[cur], newSeg: true });
    while (cur < seg.length - 1) {
      // 重なりが minOverlap 以上を保てる最も先のコマ
      let far = cur + 1;
      while (far + 1 < seg.length && overlapFrac(seg[cur], seg[far + 1], w, h) >= minOverlap) far++;
      // 候補の窓の中で最も止まっているコマ
      let pick = far;
      for (let k = far; k > cur && k >= far - 3; k--) {
        if (overlapFrac(seg[cur], seg[k], w, h) < minOverlap && k !== cur + 1) continue;
        if (seg[k].speed < seg[pick].speed) pick = k;
      }
      mine.push({ ...seg[pick], newSeg: false });
      cur = pick;
    }
    // 経路の端など、選んだコマの範囲に入っていない所が残るコマも加える
    for (const s of seg) {
      if (!mine.includes(s) && uncoveredBy(s, mine, w, h) > 0.02) mine.push({ ...s, newSeg: false });
    }
    mine.sort((a, b) => a.t - b.t);
    mine[0].newSeg = true;
    keys.push(...mine);
  }
  return keys;
}
