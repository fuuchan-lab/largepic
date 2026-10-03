// 分割保存（タイル形式）：画素数の制限なしに、画質をそのままで保存してビューアで見るための形式。
//   .zip（無圧縮）の中に manifest.json と、地図アプリのようなタイルのピラミッドを入れる。
//     L0/x_y.png … 元の解像度のタイル（PNG・劣化なし）
//     L1/…, L2/… … 1/2, 1/4, … に縮小したタイル（全体を速く表示するため）
//   ZIP なので、ふつうのアプリで展開してタイル画像をそのまま取り出すこともできる。
import { newCanvas, canvasToBlob, decodeBitmap } from './imageutil.js';

export const TILE_FORMAT = 'largepic-tiles';

// ---------- ZIP（無圧縮）の書き出し／読み込み ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipWriter {
  constructor() { this.parts = []; this.entries = []; this.offset = 0; }

  async add(name, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);          // 必要バージョン
    h.setUint16(6, 0x0800, true);      // 名前は UTF-8
    h.setUint16(8, 0, true);           // 無圧縮（PNG/JPEG はすでに圧縮済み）
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); // 日付 1980-01-01
    h.setUint32(14, crc, true);
    h.setUint32(18, bytes.length, true);
    h.setUint32(22, bytes.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);
    this.entries.push({ nameBytes, crc, size: bytes.length, offset: this.offset });
    this.parts.push(h.buffer, nameBytes, blob);
    this.offset += 30 + nameBytes.length + bytes.length;
  }

  finish() {
    const cdStart = this.offset;
    let cdSize = 0;
    for (const e of this.entries) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true);
      h.setUint16(4, 20, true); h.setUint16(6, 20, true);
      h.setUint16(8, 0x0800, true); h.setUint16(10, 0, true);
      h.setUint16(12, 0, true); h.setUint16(14, 0x21, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.size, true); h.setUint32(24, e.size, true);
      h.setUint16(28, e.nameBytes.length, true);
      h.setUint32(42, e.offset, true);
      this.parts.push(h.buffer, e.nameBytes);
      cdSize += 46 + e.nameBytes.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, cdStart, true);
    this.parts.push(end.buffer);
    return new Blob(this.parts, { type: 'application/zip' });
  }
}

export class ZipReader {
  constructor(file) { this.file = file; this.map = new Map(); }

  static async open(blob) {
    const z = new ZipReader(blob);
    const tail = await blob.slice(Math.max(0, blob.size - 65557)).arrayBuffer();
    const v = new DataView(tail);
    let p = tail.byteLength - 22;
    while (p >= 0 && v.getUint32(p, true) !== 0x06054b50) p--;
    if (p < 0) throw new Error('ZIP として読めません');
    const count = v.getUint16(p + 10, true), cdSize = v.getUint32(p + 12, true), cdOff = v.getUint32(p + 16, true);
    const cd = await blob.slice(cdOff, cdOff + cdSize).arrayBuffer();
    const d = new DataView(cd);
    let q = 0;
    for (let i = 0; i < count; i++) {
      if (d.getUint32(q, true) !== 0x02014b50) throw new Error('ZIP の目次が壊れています');
      const method = d.getUint16(q + 10, true), size = d.getUint32(q + 24, true);
      const nl = d.getUint16(q + 28, true), el = d.getUint16(q + 30, true), cl = d.getUint16(q + 32, true);
      const off = d.getUint32(q + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(cd, q + 46, nl));
      z.map.set(name, { off, size, method });
      q += 46 + nl + el + cl;
    }
    return z;
  }

  has(name) { return this.map.has(name); }

  async blob(name, type) {
    const e = this.map.get(name);
    if (!e) return null;
    if (e.method !== 0) throw new Error('圧縮された ZIP には対応していません');
    const h = new DataView(await this.blob_(e.off, 30));
    const start = e.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    return this.blob_slice(start, e.size, type);
  }
  blob_(off, n) { return this.file.slice(off, off + n).arrayBuffer(); }
  blob_slice(start, n, type) { return this.file.slice(start, start + n, type); }
}

export async function isZip(blob) {
  const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

// ---------- タイルの書き出し ----------
// mosaic のうち region（モザイク座標）を、倍率 scale のタイルのピラミッドにして ZIP の Blob を返す。
// キャンバスの大きさの上限を受けないので、いくらでも大きな画像にできる。
export async function exportTiles(mosaic, {
  region = null, scale = 1, background = '#ffffff', circle = false,
  tileSize = 1024, onProgress, isCancelled, name = 'LargePic',
} = {}) {
  const bb = region || mosaic.bbox();
  if (!bb) throw new Error('画像がありません');
  const W = Math.max(1, Math.round(bb.w * scale)), H = Math.max(1, Math.round(bb.h * scale));
  const T = tileSize;
  const alpha = circle || background === 'transparent';
  // 何も描かれない空タイルは作らない（ビューアが背景色で埋める）。丸のときは円の外側だけ省く
  const outsideEllipse = (x0, y0, tw, th) => {
    const cx = W / 2, cy = H / 2;
    const nx = Math.min(Math.max(cx, x0), x0 + tw), ny = Math.min(Math.max(cy, y0), y0 + th);
    return ((nx - cx) / (W / 2)) ** 2 + ((ny - cy) / (H / 2)) ** 2 > 1;
  };
  const skipEmpty = (x0, y0, tw, th) => (circle ? (background === 'transparent' || outsideEllipse(x0, y0, tw, th)) : true);
  const zip = new ZipWriter();
  const tileExt = {};
  let levels = 0;
  while (Math.ceil(W / 2 ** levels) > T || Math.ceil(H / 2 ** levels) > T) levels++;

  // 作業量（進捗表示用）
  const nx0 = Math.ceil(W / T), ny0 = Math.ceil(H / T);
  let total = nx0 * ny0, w = W, h = H;
  for (let z = 1; z <= levels; z++) { w = Math.ceil(w / 2); h = Math.ceil(h / 2); total += Math.ceil(w / T) * Math.ceil(h / T); }
  let done = 0;
  const tick = () => onProgress?.(++done / total);

  // --- レベル 0：元の解像度（PNG、劣化なし） ---
  const tiles = mosaic.placed().filter((t) =>
    t.x < bb.x + bb.w && t.y < bb.y + bb.h && t.x + t.w > bb.x && t.y + t.h > bb.y);
  const decoded = new Map();
  const bitmapOf = async (t) => {
    if (decoded.has(t.id)) { const v = decoded.get(t.id); decoded.delete(t.id); decoded.set(t.id, v); return v; }
    const v = await mosaic.loadFull(t);   // 画面表示用のキャッシュとは別に読み込む（途中で閉じられないように）
    decoded.set(t.id, v);
    while (decoded.size > 10) {
      const [k, old] = decoded.entries().next().value;
      decoded.delete(k);
      old.close?.();
    }
    return v;
  };
  const blobs = new Map();    // `${z}/${x}_${y}` → Blob
  tileExt[0] = 'png';
  for (let ty = 0; ty < ny0; ty++) {
    for (let tx = 0; tx < nx0; tx++) {
      if (isCancelled?.()) throw new Error('中止しました');
      const x0 = tx * T, y0 = ty * T, tw = Math.min(T, W - x0), th = Math.min(T, H - y0);
      // このタイルに重なる元画像
      const over = tiles.filter((t) => {
        const a = (t.x - bb.x) * scale, b = (t.y - bb.y) * scale;
        return a < x0 + tw && b < y0 + th && a + t.w * scale > x0 && b + t.h * scale > y0;
      });
      if (!over.length && skipEmpty(x0, y0, tw, th)) { tick(); continue; }
      const c = newCanvas(tw, th);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (circle) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(W / 2 - x0, H / 2 - y0, W / 2, H / 2, 0, 0, Math.PI * 2);
        ctx.clip();
      }
      if (background !== 'transparent') { ctx.fillStyle = background; ctx.fillRect(0, 0, tw, th); }
      for (const t of over) {
        const bmp = await bitmapOf(t);
        // 隣のタイルとの境目に隙間ができないよう、座標は整数にそろえて描く
        const dx = Math.round((t.x - bb.x) * scale) - x0, dy = Math.round((t.y - bb.y) * scale) - y0;
        ctx.drawImage(bmp, dx, dy, Math.round(t.w * scale), Math.round(t.h * scale));
      }
      if (circle) ctx.restore();
      const blob = await canvasToBlob(c, 'image/png');
      c.width = c.height = 0;
      blobs.set(`0/${tx}_${ty}`, blob);
      await zip.add(`L0/${tx}_${ty}.png`, blob);
      tick();
    }
  }
  for (const v of decoded.values()) v.close?.();
  decoded.clear();

  // --- レベル 1 以降：1/2 ずつ縮小（表示を速くするための縮小タイル） ---
  let pw = W, ph = H;
  for (let z = 1; z <= levels; z++) {
    const lw = Math.ceil(pw / 2), lh = Math.ceil(ph / 2);
    const nx = Math.ceil(lw / T), ny = Math.ceil(lh / T), pnx = Math.ceil(pw / T);
    const ext = alpha ? 'png' : 'jpg';
    tileExt[z] = ext;
    for (let ty = 0; ty < ny; ty++) {
      for (let tx = 0; tx < nx; tx++) {
        if (isCancelled?.()) throw new Error('中止しました');
        const x0 = tx * T, y0 = ty * T, tw = Math.min(T, lw - x0), th = Math.min(T, lh - y0);
        // 子（1つ下のレベル）の 2×2 タイルを重ねて縮小する
        const big = newCanvas(tw * 2, th * 2);
        const bctx = big.getContext('2d');
        if (background !== 'transparent') { bctx.fillStyle = background; bctx.fillRect(0, 0, big.width, big.height); }
        let any = false;
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const cx = tx * 2 + i, cy = ty * 2 + j;
            if (cx >= pnx) continue;
            const key = `${z - 1}/${cx}_${cy}`;
            const cb = blobs.get(key);
            if (!cb) continue;
            const bmp = await decodeBitmap(cb);
            bctx.drawImage(bmp, i * T, j * T);
            bmp.close?.();
            any = true;
          }
        }
        if (!any && skipEmpty(x0 * 2 ** z, y0 * 2 ** z, tw * 2 ** z, th * 2 ** z)) { big.width = big.height = 0; tick(); continue; }
        const c = newCanvas(tw, th);
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(big, 0, 0, tw * 2, th * 2, 0, 0, tw, th);
        big.width = big.height = 0;
        const blob = await canvasToBlob(c, ext === 'png' ? 'image/png' : 'image/jpeg', 0.92);
        c.width = c.height = 0;
        blobs.set(`${z}/${tx}_${ty}`, blob);
        await zip.add(`L${z}/${tx}_${ty}.${ext}`, blob);
        tick();
      }
    }
    // 1つ下のレベルの作業用データはもう要らない
    for (const k of [...blobs.keys()]) if (k.startsWith(`${z - 1}/`)) blobs.delete(k);
    pw = lw; ph = lh;
  }

  const manifest = {
    format: TILE_FORMAT, version: 1, name,
    width: W, height: H, tileSize: T, levels, tileExt,
    background, circle, fillMissing: !circle && background !== 'transparent', createdAt: new Date().toISOString(),
  };
  await zip.add('manifest.json', new Blob([JSON.stringify(manifest, null, 1)], { type: 'application/json' }));
  return { blob: zip.finish(), manifest };
}
