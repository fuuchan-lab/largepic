// 動画の事前解析：小さな画像で全体の動きをざっと追い、取り込むべきコマ（キーフレーム）だけを選ぶ。
// 本番の取り込み（高解像度の位置合わせ・タイル作成）は選んだコマだけに行うので速い。
//  1) 再生しながら（requestVideoFrameCallback）または一定間隔のシークで、縮小したコマを集める
//  2) 隣り合うコマの移動量を粗い解像度で求めて、軌跡（スクロールの経路）を作る
//  3) 経路上で、前のキーフレームと十分重なる範囲でできるだけ「止まっている」コマを選ぶ
import { cropRect, newCanvas } from './imageutil.js';
import { coarseMatch, scalesFor } from './register.js';
import { yieldNow } from './awake.js';
import { perf } from './perf.js';
import { maskPx, flattenGray, inMask } from './mask.js';

const ANALYSIS_SIDE = 112;   // 解析用に縮小した画像の長辺（px）

function waitSeeked(video, t, ms = 4000) {
  return new Promise((res) => {
    const done = () => { clearTimeout(to); video.removeEventListener('seeked', done); res(); };
    const to = setTimeout(done, ms);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

// 縮小して粗い特徴（register.js の coarse と同じ形）を作る
function makeGrabber(video, crop, mask = null) {
  const r = cropRect(video.videoWidth, video.videoHeight, crop);
  const sc = Math.min(1, ANALYSIS_SIDE / Math.max(r.w, r.h));   // 解析用の画像は小さくてよい（位置の細かい合わせは本番の取り込みでやる）
  const cw = Math.max(8, Math.round(r.w * sc)), ch = Math.max(8, Math.round(r.h * sc));
  const cv = newCanvas(cw, ch);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'medium';
  const m = mask && mask.on ? maskPx(mask, cw, ch, 1) : null;   // 記録しない領域は、解析でも使わない
  return {
    w: r.w, h: r.h, scale: cw / r.w,
    grab() {
      ctx.drawImage(video, r.sx, r.sy, r.w, r.h, 0, 0, cw, ch);
      const d = ctx.getImageData(0, 0, cw, ch).data;
      const g = new Float32Array(cw * ch);
      for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) / 256;
      if (m) flattenGray(g, cw, ch, m);
      return { w: r.w, h: r.h, _fft: null, coarse: { data: g, w: cw, h: ch, scale: cw / r.w } };
    },
  };
}

// 再生しながらコマを集める。コマが届くたびに onSample() で処理する（集めながら位置も追うので、待ち時間が重ならない）。
// 処理が追いつくよう、1コマの処理時間に合わせて再生速度を調整する（処理が軽いほど速く再生できる）。
// コールバックが来ない環境では false を返す（呼び出し側でシークに切り替える）
async function collectByPlayback(video, grabber, { start, end, step, onProgress, isCancelled, onSample }) {
  if (!('requestVideoFrameCallback' in video)) return false;
  let count = 0;
  await waitSeeked(video, start);
  const prevRate = video.playbackRate;
  video.playbackRate = 2;
  try { await video.play(); } catch { video.playbackRate = prevRate; return false; }
  return new Promise((resolve) => {
    let last = -Infinity, lastCb = performance.now(), finished = false, lastMedia = -Infinity;
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
      if (performance.now() - lastCb > 3000) finish(count >= 3);
    }, 500);
    const cb = (now, meta) => {
      if (finished) return;
      lastCb = performance.now();
      const t = meta.mediaTime;
      lastMedia = t;
      if (t - last >= step * 0.9 && t >= start - 1e-3 && t <= end + 1e-3) {
        const t0 = performance.now();
        onSample({ t, feat: grabber.grab() });
        count++;
        last = t;
        onProgress?.((t - start) / Math.max(0.01, end - start));
        // 1コマの処理時間に合わせた再生速度：コマの間隔（メディア時間 step）の間に処理が終わるように
        const work = performance.now() - t0;
        video.playbackRate = Math.max(1, Math.min(4, (step * 1000 * 0.85) / (work + 4)));
      }
      if (t >= end - 0.02 || video.ended || isCancelled?.()) {
        // 最後のコマは、間隔が近くても必ず取る（端まで取り込むため）
        if (t - last > 0.02 && t <= end + 1e-3 && !isCancelled?.()) { onSample({ t, feat: grabber.grab() }); count++; }
        return finish(true);
      }
      video.requestVideoFrameCallback(cb);
    };
    video.addEventListener('ended', () => {
      // 動画の最後のコマは、再生中のコールバックが来ないことがある。終わった時点で表示されている最後のコマを、
      // 動画の長さの時刻のコマとして取る（端まで取り込むため）
      if (!finished && end >= video.duration - 0.05 && video.duration - last > 0.03) {
        onSample({ t: video.duration, feat: grabber.grab() });
        count++;
      }
      finish(true);
    }, { once: true });
    video.requestVideoFrameCallback(cb);
  });
}

async function collectBySeek(video, grabber, { start, end, step, onProgress, isCancelled, onSample }) {
  for (let t = start; t < end - 1e-3; t += step) {
    if (isCancelled?.()) break;
    await waitSeeked(video, t);
    onSample({ t, feat: grabber.grab() });
    onProgress?.((t - start) / Math.max(0.01, end - start));
    await yieldNow();
  }
}

// 解析：サンプルごとの位置（区間ごとの相対座標）を求める
// 戻り値: { samples: [{t, x, y, seg, speed}], w, h, brokenFraction }
export async function analyzeVideo(video, crop, opts) {
  const grabber = makeGrabber(video, crop, opts.mask);
  const step = opts.step ?? 0.1;
  const sc = grabber.scale;
  const threshold = (opts.threshold ?? 0.55) * 0.85;

  // コマが届くたびに、直前のコマとの移動量を求めて経路（軌跡）を延ばす
  const newState = () => ({ out: [], seg: 0, x: 0, y: 0, prev: null, vel: null, broken: 0, n: 0 });
  let st = newState();
  const feed = (sample) => {
    const { t, feat } = sample;
    st.n++;
    if (!st.prev) {
      st.out.push({ t, x: st.x, y: st.y, seg: st.seg, speed: Infinity });
    } else {
      // まず小さな FFT（ずれが画面の 7 割以内）で試し、合わなければ全範囲で探し直す
      const r = perf.timeSync('analysis.match', () => {
        const o = { hint: st.vel || undefined, prior: st.vel || undefined };
        const q = coarseMatch(st.prev.feat, feat, { ...o, maxShift: 0.7 });
        return q && q.score >= threshold ? q : (coarseMatch(st.prev.feat, feat, o) || q);
      });
      if (r && r.score >= threshold) {
        const dx = r.dx / sc, dy = r.dy / sc;
        st.x += dx; st.y += dy; st.vel = { dx, dy };
        st.out.push({ t, x: st.x, y: st.y, seg: st.seg, speed: Math.hypot(dx, dy) / Math.max(0.01, t - st.prev.t) });
      } else {
        // 追えなかった：ここから新しい区間（座標は区間ごとの相対）
        st.seg++; st.x = 0; st.y = 0; st.vel = null; st.broken++;
        st.out.push({ t, x: 0, y: 0, seg: st.seg, speed: Infinity, newSeg: true });
      }
      st.prev.feat = null; // 使い終わったコマはメモリから外す
    }
    st.prev = sample;
  };

  const tc = performance.now();
  const o = { ...opts, step, onSample: feed };
  let mode = 'playback';
  const ok = await collectByPlayback(video, grabber, o);
  if (!ok || st.n < 3) {
    st = newState();      // 再生で集められなかったので、最初から一定間隔のシークでやり直す
    mode = 'seek';
    await collectBySeek(video, grabber, o);
  }
  perf.add('analysis.collect', performance.now() - tc);
  return { samples: st.out, w: grabber.w, h: grabber.h, mode, brokenFraction: st.n ? st.broken / st.n : 1 };
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

// 選んだコマ（キーフレーム）を、動画を再生しながら取り出す読み取り係。
// コマごとにシークするより速い（シークはコマごとに近くのキーフレームまで戻って読み直すので遅い）。
// 目的のコマが出た瞬間に再生を止めて取り込み、処理が終わったら続きから再生する。
// 再生で取り出せない環境（requestVideoFrameCallback がない等）では、従来どおりシークする。
export function makeKeyReader(video, grabFull, seek) {
  let broken = !('requestVideoFrameCallback' in video);
  const bySeek = async (t, why = '') => { perf.add('key.bySeek' + why, 0); video.pause(); await seek(video, t); return grabFull(); };
  return {
    async get(t) {
      if (t >= video.duration - 1e-3) return bySeek(t, '(last)');   // 動画の最後のコマは、シークで確実に取る
      if (broken || video.currentTime > t + 0.02) return bySeek(t, broken ? '(broken)' : '(back)');   // すでに過ぎた時刻（逆戻り）はシーク
      return new Promise((resolve) => {
        let done = false, lastCb = performance.now();
        const finish = (v) => { if (done) return; done = true; clearInterval(watch); resolve(v); };
        const fallback = async () => { broken = true; finish(await bySeek(t, '(fallback)')); };
        // 3 秒コールバックが来なければ、シークに切り替える
        const watch = setInterval(() => { if (performance.now() - lastCb > 3000) fallback(); }, 500);
        const cb = async (now, meta) => {
          if (done) return;
          lastCb = performance.now();
          if (meta.mediaTime >= t - 1e-3) {
            video.pause();
            // 目的のコマから大きくずれた（コマが飛んだ）ときは、正確にシークし直す
            if (meta.mediaTime - t > 0.04) return finish(await bySeek(t, '(skip)'));
            perf.add('key.byPlay', 0);
            return finish(grabFull());
          }
          // 目的のコマが遠いうちは速く、近づいたらゆっくり（コマを飛ばさないため）
          const remain = t - meta.mediaTime;
          video.playbackRate = remain > 0.8 ? 6 : remain > 0.3 ? 3 : 1.5;
          video.requestVideoFrameCallback(cb);
        };
        video.playbackRate = Math.abs(t - video.currentTime) > 0.8 ? 6 : 2;
        video.play().then(() => video.requestVideoFrameCallback(cb)).catch(fallback);
      });
    },
  };
}

// 動画の中で「画面の同じ位置に居続ける物」（ポインター・キャラクターなど）を見つける。
// 地図が動いても動かない、模様のある画素を数え、まとまった領域（連結成分）を探して、記録しない領域の案にする。
// 戻り値: { found: true, mask: { shape, cx, cy, rw, rh } } または { found: false, reason }
export async function detectStatic(video, crop, { start = 0, end, seek, onProgress, maxSamples = 40 } = {}) {
  const grabber = makeGrabber(video, crop, null);
  const dur = Math.max(0.5, end - start);
  const n = Math.min(maxSamples, Math.max(8, Math.round(dur / 0.25)));
  const feats = [];
  for (let i = 0; i < n; i++) {
    await seek(video, start + dur * (i + 0.5) / n);
    feats.push(grabber.grab());
    onProgress?.(i / n * 0.7);
    await yieldNow();
  }
  const W = feats[0].coarse.w, H = feats[0].coarse.h, N = W * H;
  const textured = new Uint16Array(N), equal = new Uint16Array(N);
  let pairs = 0;
  for (let i = 0; i + 1 < n; i++) {
    const a = feats[i], b = feats[i + 1];
    const r = coarseMatch(a, b, { candidates: 6 });
    if (!r || r.score < 0.5 || Math.hypot(r.dx, r.dy) < 3) continue;   // 地図が動いていないコマの組は、判断できないので使わない
    pairs++;
    const da = a.coarse.data, db = b.coarse.data;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (Math.abs(da[p + 1] - da[p - 1]) + Math.abs(da[p + W] - da[p - W]) > 14) {   // 模様のある画素だけ（無地の海などは数えない）
          textured[p]++;
          if (Math.abs(da[p] - db[p]) < 7) equal[p]++;
        }
      }
    }
    onProgress?.(0.7 + 0.2 * (i / n));
    await yieldNow();
  }
  if (pairs < 3) return { found: false, reason: '地図が動いているコマが足りません。スクロールしている動画で試してください。' };
  // 動かない画素
  const st = new Uint8Array(N);
  for (let p = 0; p < N; p++) if (textured[p] >= Math.max(3, pairs * 0.5) && equal[p] >= 0.85 * textured[p]) st[p] = 1;
  // 少し太らせて、近くの画素をつなげる
  const dilate = (src) => {
    const o = new Uint8Array(N);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (src[p] || src[p - 1] || src[p + 1] || src[p - W] || src[p + W] || src[p - W - 1] || src[p - W + 1] || src[p + W - 1] || src[p + W + 1]) o[p] = 1;
    }
    return o;
  };
  const d2 = dilate(dilate(st));
  // 連結成分
  const label = new Int32Array(N).fill(-1);
  const comps = [];
  for (let p0 = 0; p0 < N; p0++) {
    if (!d2[p0] || label[p0] >= 0) continue;
    const id = comps.length;
    const stack = [p0]; label[p0] = id;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0, raw = 0;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      area++; if (st[p]) raw++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < N && d2[q] && label[q] < 0) { label[q] = id; stack.push(q); }
    }
    comps.push({ x0, y0, x1, y1, area, raw });
  }
  const good = comps.filter((c) => c.raw >= 6);
  if (!good.length) return { found: false, reason: '動かない物は見つかりませんでした。範囲を自分で指定することもできます。' };
  // 画面の真ん中に近く、ある程度大きいものを選ぶ
  const maxArea = Math.max(...good.map((c) => c.area));
  const cand = good.filter((c) => c.area >= maxArea * 0.3);
  cand.sort((a, b) => Math.hypot((a.x0 + a.x1) / 2 - W / 2, (a.y0 + a.y1) / 2 - H / 2) - Math.hypot((b.x0 + b.x1) / 2 - W / 2, (b.y0 + b.y1) / 2 - H / 2));
  const c = cand[0];
  const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
  const fill = c.raw / (bw * bh);
  const m = 0.12;   // 余白（にじみ・影の分）
  onProgress?.(1);
  const mask = {
    shape: fill >= 0.55 ? 'rect' : 'ellipse',
    cx: (c.x0 + c.x1 + 1) / 2 / W, cy: (c.y0 + c.y1 + 1) / 2 / H,
    rw: Math.min(0.45, (bw / 2 / W) * (fill >= 0.55 ? 1 + m : 1.3)), rh: Math.min(0.45, (bh / 2 / H) * (fill >= 0.55 ? 1 + m : 1.3)),
  };
  return { found: true, mask, pairs };
}
