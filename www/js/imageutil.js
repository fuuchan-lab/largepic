// 画像まわりの小物
export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isMobile = isIOS || /Android|Mobile/.test(navigator.userAgent);

export function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// crop: { top, bottom, left, right } … 各辺から除外する割合 (0〜1)
export function cropRect(sw, sh, crop) {
  const sx = Math.round(sw * crop.left), ex = Math.round(sw * (1 - crop.right));
  const sy = Math.round(sh * crop.top), ey = Math.round(sh * (1 - crop.bottom));
  return { sx, sy, w: Math.max(16, ex - sx), h: Math.max(16, ey - sy) };
}

function toGray(d, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return g;
}

let work = null;
// source を切り抜いて作業用キャンバスに描き、グレースケールも返す
// （キャンバスは使い回すので、必要なら呼び出し側ですぐ使うこと）
import { perf } from './perf.js';
export function grabFrame(source, sw, sh, crop) {
  return perf.timeSync('grab', () => grabFrameImpl(source, sw, sh, crop));
}
function grabFrameImpl(source, sw, sh, crop) {
  const r = cropRect(sw, sh, crop);
  if (!work) work = newCanvas(1, 1);
  if (work.width !== r.w || work.height !== r.h) { work.width = r.w; work.height = r.h; }
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, r.sx, r.sy, r.w, r.h, 0, 0, r.w, r.h);
  const gray = toGray(ctx.getImageData(0, 0, r.w, r.h).data, r.w * r.h);
  return { canvas: work, gray, w: r.w, h: r.h, rect: r };
}

export function grayOf(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const c = newCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const g = toGray(ctx.getImageData(0, 0, w, h).data, w * h);
  c.width = c.height = 0;
  return g;
}

export async function makeThumb(canvas, w, h, maxDim = 640) {
  const s = Math.min(1, maxDim / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  const c = newCanvas(tw, th);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h, 0, 0, tw, th);
  const bmp = await createImageBitmap(c);
  c.width = c.height = 0;
  return { bmp, scale: tw / w };
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('画像の書き出しに失敗しました（サイズが大きすぎる可能性）'))), type, quality));
}

export async function decodeBitmap(blob) {
  try {
    return await createImageBitmap(blob);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// ImageBitmap / Canvas がほぼ真っ黒・透明（読み込みに失敗した状態）かどうか
// 縮小して数点を調べるだけなので軽い。地図は真っ黒にならない前提。
export function isBlank(source) {
  const c = newCanvas(16, 16);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, 16, 16);
  const d = ctx.getImageData(0, 0, 16, 16).data;
  c.width = c.height = 0;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8 && d[i] + d[i + 1] + d[i + 2] > 24) lit++;
  return lit < 3;
}

// blob の (sx,sy,w,h) 部分を ImageBitmap として取り出す
// createImageBitmap の切り出し引数は iOS Safari で空白になることがあるため使わず、
// 全体を読み込んでから（必要なら）キャンバスで切り出す。
export async function decodeCrop(blob, sx, sy, w, h) {
  const full = await decodeBitmap(blob);
  const fw = full.naturalWidth || full.width, fh = full.naturalHeight || full.height;
  if (sx === 0 && sy === 0 && fw === w && fh === h && full.close) return full;
  const c = newCanvas(w, h);
  c.getContext('2d').drawImage(full, sx, sy, w, h, 0, 0, w, h);
  if (full.close) full.close();
  const bmp = await createImageBitmap(c);
  c.width = c.height = 0;
  return bmp;
}

import { yieldNow } from './awake.js';
export const nextFrame = yieldNow;   // 裏のタブでも間引かれない待ち方（awake.js）
