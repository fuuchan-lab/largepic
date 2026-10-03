// 保存した画像のライブラリ（この端末の中、IndexedDB）。
// 保存（書き出し）するたびに自動で入り、［🔍 閲覧］で一覧から優先して開ける。
// 本体（重いデータ）とメタ情報（サムネイル付き）を別に保存するので、一覧は軽く開ける。
import { newCanvas, canvasToBlob, decodeBitmap } from './imageutil.js';
import { ZipReader, isZip, TILE_FORMAT } from './tiles.js';

const DB = 'largepic-library';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('meta', { keyPath: 'id' });
      db.createObjectStore('files');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

// 一覧用の小さなサムネイル（JPEG）。分割保存は、いちばん粗いレベルのタイルを使う
export async function makeLibraryThumb(blob, maxDim = 320) {
  let bmp = null;
  try {
    if (await isZip(blob)) {
      const z = await ZipReader.open(blob);
      const m = JSON.parse(await (await z.blob('manifest.json')).text());
      if (m.format !== TILE_FORMAT) return null;
      const ext = m.tileExt[m.levels] || 'png';
      const t = await z.blob(`L${m.levels}/0_0.${ext}`, ext === 'png' ? 'image/png' : 'image/jpeg');
      if (!t) return null;
      bmp = await decodeBitmap(t);
      // いちばん粗いタイルは全体の縮小図（端の欠けは背景色）なので、そのまま縮小する
      const k = 2 ** -m.levels;
      const w = Math.max(1, Math.round(m.width * k)), h = Math.max(1, Math.round(m.height * k));
      return await shrink(bmp, 0, 0, Math.min(w, bmp.width), Math.min(h, bmp.height), maxDim, m.fillMissing ? m.background : null);
    }
    bmp = await decodeBitmap(blob);
    return await shrink(bmp, 0, 0, bmp.naturalWidth || bmp.width, bmp.naturalHeight || bmp.height, maxDim, null);
  } catch (e) {
    console.warn('サムネイルを作れません', e);
    return null;
  } finally {
    bmp?.close?.();
  }
}

async function shrink(src, sx, sy, sw, sh, maxDim, bg) {
  const k = Math.min(1, maxDim / Math.max(sw, sh));
  const c = newCanvas(Math.max(1, Math.round(sw * k)), Math.max(1, Math.round(sh * k)));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.fillStyle = bg && bg !== 'transparent' ? bg : '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const out = await canvasToBlob(c, 'image/jpeg', 0.85);
  c.width = c.height = 0;
  return out;
}

export const library = {
  async add({ name, blob, kind, width, height }) {
    const db = await open();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const thumb = await makeLibraryThumb(blob);
    const meta = { id, name, kind, width, height, size: blob.size, type: blob.type, createdAt: Date.now(), thumb };
    const t = db.transaction(['meta', 'files'], 'readwrite');
    t.objectStore('files').put(blob, id);
    t.objectStore('meta').put(meta);
    await done(t);
    try { await navigator.storage?.persist?.(); } catch { /* 対応していない端末もある */ }
    return meta;
  },

  async list() {
    const db = await open();
    const all = await req(db.transaction('meta').objectStore('meta').getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },

  async blob(id) {
    const db = await open();
    return req(db.transaction('files').objectStore('files').get(id));
  },

  async remove(id) {
    const db = await open();
    const t = db.transaction(['meta', 'files'], 'readwrite');
    t.objectStore('meta').delete(id);
    t.objectStore('files').delete(id);
    await done(t);
  },

  async usage() {
    try { const e = await navigator.storage?.estimate?.(); return e ? { used: e.usage, quota: e.quota } : null; } catch { return null; }
  },
};
