// 作業中のプロジェクトを端末内 (IndexedDB) に自動保存する
// 撮影のために他のアプリへ切り替えている間にページが閉じられても、続きから再開できる
import { decodeCrop, decodeBitmap, grayOf, makeThumb, isBlank, newCanvas, canvasToBlob } from './imageutil.js';
import { makeFeatures, scalesFor } from './register.js';

const DB = 'largepic';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('meta');
      db.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(db, stores, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export class ProjectStore {
  constructor(mosaic) {
    this.mosaic = mosaic;
    this.saved = new Set(); // 保存済み blob の id
    this.timer = 0;
    this.enabled = typeof indexedDB !== 'undefined';
    this.saving = Promise.resolve();
  }

  // 変更のたびに呼ぶ（まとめて保存）
  schedule() {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.saving = this.save().catch((e) => console.warn('save failed', e)); }, 600);
  }

  async flush() {
    clearTimeout(this.timer);
    await this.saving;
    if (this.enabled) await this.save();
  }

  async save() {
    const db = await open();
    const tiles = this.mosaic.tiles;
    const ids = new Set(tiles.map((t) => t.id));
    const meta = {
      version: 1,
      nextId: this.mosaic.nextId,
      tiles: tiles.map((t) => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h, placed: t.placed, sx: t.sx, sy: t.sy })),
    };
    const add = tiles.filter((t) => !this.saved.has(t.id));
    const del = [...this.saved].filter((id) => !ids.has(id));
    // 元画像の読み込みに失敗したときの保険として、小さなプレビュー(JPEG)も別に保存する
    const previews = new Map();
    for (const tile of add) {
      try {
        const c = newCanvas(tile.thumb.width, tile.thumb.height);
        c.getContext('2d').drawImage(tile.thumb, 0, 0);
        previews.set(tile.id, await canvasToBlob(c, 'image/jpeg', 0.9));
        c.width = c.height = 0;
      } catch { /* プレビューなしでも保存は続ける */ }
    }
    await tx(db, ['meta', 'blobs'], 'readwrite', (t) => {
      const b = t.objectStore('blobs');
      for (const tile of add) b.put(tile.src, tile.id);
      for (const [id, blob] of previews) b.put(blob, 'p' + id);
      for (const id of del) { b.delete(id); b.delete('p' + id); }
      t.objectStore('meta').put(meta, 'project');
    });
    for (const tile of add) this.saved.add(tile.id);
    for (const id of del) this.saved.delete(id);
  }

  async hasProject() {
    if (!this.enabled) return false;
    try {
      const db = await open();
      const m = await req(db.transaction('meta').objectStore('meta').get('project'));
      return !!(m && m.tiles && m.tiles.length);
    } catch {
      return false;
    }
  }

  async load(stitcher, onProgress) {
    const db = await open();
    const t = db.transaction(['meta', 'blobs']);
    const meta = await req(t.objectStore('meta').get('project'));
    if (!meta || !meta.tiles?.length) return 0;
    const first = meta.tiles[0];
    stitcher.scales = scalesFor(first.w, first.h);
    let n = 0;
    for (const m of meta.tiles) {
      const os = db.transaction('blobs').objectStore('blobs');
      const src = await req(os.get(m.id));
      if (!src) continue;
      const preview = await req(os.get('p' + m.id));
      let bad = false;
      let bmp = null;
      try { bmp = await decodeCrop(src, m.sx, m.sy, m.w, m.h); } catch { /* 下で代替 */ }
      if (!bmp || isBlank(bmp)) {
        // 元画像を読み込めない（真っ黒）→ プレビューから復元して位置合わせは粗い解像度で行う
        bmp?.close?.();
        bad = true;
        if (!preview) continue;
        const pv = await decodeBitmap(preview);
        const c = newCanvas(m.w, m.h);
        c.getContext('2d').drawImage(pv, 0, 0, m.w, m.h);
        pv.close?.();
        bmp = await createImageBitmap(c);
        c.width = c.height = 0;
      }
      const gray = grayOf(bmp);
      const { bmp: thumb, scale } = await makeThumb(bmp, m.w, m.h, stitcher.settings.thumbSize);
      bmp.close?.();
      const feat = makeFeatures(gray, m.w, m.h, stitcher.scales);
      feat.full = null;
      this.mosaic.tiles.push({ ...m, thumb, thumbScale: scale, src, feat, fullBad: bad, grayBad: bad });
      this.saved.add(m.id);
      if (bad) this.mosaic.warn?.('一部の画像を高解像度で読み込めませんでした');
      onProgress?.(++n / meta.tiles.length);
    }
    this.mosaic.nextId = Math.max(meta.nextId || 1, ...this.mosaic.tiles.map((x) => x.id + 1));
    this.mosaic.changed();
    return n;
  }

  async clear() {
    if (!this.enabled) return;
    const db = await open();
    await tx(db, ['meta', 'blobs'], 'readwrite', (t) => {
      t.objectStore('meta').clear();
      t.objectStore('blobs').clear();
    });
    this.saved.clear();
  }
}
