// ビューアの画像の読み込み元：1枚の画像、または分割保存（タイル形式）
import { newCanvas, decodeBitmap } from './imageutil.js';
import { ZipReader, TILE_FORMAT } from './tiles.js';

const MAX_CANVAS_AREA = 16e6; // iOS Safari のキャンバス上限（約1,677万画素）に収める

// 1枚の画像（縮小画像＝ミップマップを作って、拡大率に合わせて使い分ける）
export class BitmapSource {
  async open(blob) {
    this.url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = this.url;
    await img.decode();
    this.img = img;
    this.w = img.naturalWidth; this.h = img.naturalHeight;
    this.levels = [{ k: 1, src: img }];
    let k = 0.5;
    while (this.w * k * this.h * k > MAX_CANVAS_AREA) k /= 2;
    let prev = img;
    while (Math.max(this.w, this.h) * k >= 200) {
      const c = newCanvas(Math.max(1, Math.round(this.w * k)), Math.max(1, Math.round(this.h * k)));
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(prev, 0, 0, c.width, c.height);
      this.levels.push({ k, src: c });
      prev = c;
      k /= 2;
    }
    return this;
  }

  draw(ctx, v) {
    const dpr = v.dpr || 1, sEff = v.s * dpr;
    // 縮小率が 1/2 以内に収まる最も小さい段を使う
    let lv = this.levels[0];
    for (const l of this.levels) if (l.k >= sEff) lv = l;
    ctx.imageSmoothingEnabled = sEff < 3;
    ctx.imageSmoothingQuality = 'high';
    // 見えている範囲だけ描く（巨大な描画先サイズを避ける）
    const x0 = Math.max(0, -v.ox / v.s), y0 = Math.max(0, -v.oy / v.s);
    const x1 = Math.min(this.w, (v.cw - v.ox) / v.s), y1 = Math.min(this.h, (v.ch - v.oy) / v.s);
    if (x1 <= x0 || y1 <= y0) return;
    const ax0 = Math.floor(x0), ay0 = Math.floor(y0), ax1 = Math.ceil(x1), ay1 = Math.ceil(y1);
    ctx.drawImage(lv.src, ax0 * lv.k, ay0 * lv.k, (ax1 - ax0) * lv.k, (ay1 - ay0) * lv.k,
      (v.ox + ax0 * v.s) * dpr, (v.oy + ay0 * v.s) * dpr, (ax1 - ax0) * v.s * dpr, (ay1 - ay0) * v.s * dpr);
  }

  dispose() {
    for (const l of this.levels || []) if (l.src instanceof HTMLCanvasElement) l.src.width = l.src.height = 0;
    this.levels = [];
    this.img = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

// 分割保存（タイル形式）：見えている範囲のタイルだけを読み込んで、継ぎ目なく表示する
export class TiledSource {
  async open(blob) {
    this.zip = await ZipReader.open(blob);
    const mb = await this.zip.blob('manifest.json');
    if (!mb) throw new Error('manifest.json がありません');
    const m = JSON.parse(await mb.text());
    if (m.format !== TILE_FORMAT) throw new Error('この形式には対応していません');
    this.m = m;
    this.w = m.width; this.h = m.height; this.T = m.tileSize; this.Z = m.levels;
    this.cache = new Map();      // key → ImageBitmap（新しく使ったものが後ろ）
    this.pixels = 0;
    this.budget = 48e6;          // 保持するタイルの合計画素数の上限（約 190MB）
    this.pending = new Set();
    this.missing = new Set();    // 空タイル（ファイルにないもの）
    this.alive = true;
    this.levels = Array.from({ length: m.levels + 1 }, (_, z) => ({ k: 2 ** -z }));
    return this;
  }

  tileExt(z) { return this.m.tileExt[z] || 'png'; }
  levelSize(z) { return [Math.ceil(this.w / 2 ** z), Math.ceil(this.h / 2 ** z)]; }

  request(z, x, y, v) {
    const key = `${z}/${x}_${y}`;
    if (this.cache.has(key) || this.pending.has(key) || this.missing.has(key) || this.pending.size >= 6) return;
    const ext = this.tileExt(z);
    const name = `L${z}/${x}_${y}.${ext}`;
    if (!this.zip.has(name)) { this.missing.add(key); return; }
    this.pending.add(key);
    (async () => {
      try {
        const blob = await this.zip.blob(name, ext === 'png' ? 'image/png' : 'image/jpeg');
        const bmp = await decodeBitmap(blob);
        if (!this.alive) { bmp.close?.(); return; }
        this.cache.set(key, bmp);
        this.pixels += bmp.width * bmp.height;
        while (this.pixels > this.budget && this.cache.size > 1) {
          const [k, old] = this.cache.entries().next().value;
          this.cache.delete(k);
          this.pixels -= old.width * old.height;
          old.close?.();
        }
      } catch (e) {
        console.warn('タイルを読めません', name, e);
        this.missing.add(key);
      } finally {
        this.pending.delete(key);
        if (this.alive) v.requestDraw();
      }
    })();
  }

  get(key) {
    const b = this.cache.get(key);
    if (b) { this.cache.delete(key); this.cache.set(key, b); }
    return b;
  }

  draw(ctx, v) {
    const dpr = v.dpr || 1, sEff = v.s * dpr, T = this.T;
    // 拡大率に合うレベル：1/2^z の縮小が、表示の縮小率以上になる最も粗いレベル
    const z = Math.max(0, Math.min(this.Z, Math.floor(-Math.log2(Math.min(1, sEff)) + 1e-9)));
    ctx.imageSmoothingEnabled = sEff < 3;
    ctx.imageSmoothingQuality = 'high';
    // ファイルにない空タイルは、背景色で埋めて見せる
    const bg = this.m.fillMissing ? this.m.background : null;
    // 見えている範囲（画像の座標）
    const vx0 = Math.max(0, -v.ox / v.s), vy0 = Math.max(0, -v.oy / v.s);
    const vx1 = Math.min(this.w, (v.cw - v.ox) / v.s), vy1 = Math.min(this.h, (v.ch - v.oy) / v.s);
    if (vx1 <= vx0 || vy1 <= vy0) return;
    const k = 2 ** -z, [lw, lh] = this.levelSize(z);
    const tx0 = Math.floor(vx0 * k / T), ty0 = Math.floor(vy0 * k / T);
    const tx1 = Math.min(Math.ceil(lw / T) - 1, Math.floor(vx1 * k / T));
    const ty1 = Math.min(Math.ceil(lh / T) - 1, Math.floor(vy1 * k / T));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const lx = tx * T, ly = ty * T;
        const tw = Math.min(T, lw - lx), th = Math.min(T, lh - ly);
        // タイルの画面上の位置（隣と隙間があかないよう、端は整数にそろえる）
        const sx0 = Math.round((v.ox + lx / k * v.s) * dpr), sy0 = Math.round((v.oy + ly / k * v.s) * dpr);
        const sx1 = Math.round((v.ox + (lx + tw) / k * v.s) * dpr), sy1 = Math.round((v.oy + (ly + th) / k * v.s) * dpr);
        const sw = sx1 - sx0, sh = sy1 - sy0;
        const key = `${z}/${tx}_${ty}`;
        const bmp = this.get(key);
        if (bmp) { ctx.drawImage(bmp, sx0, sy0, sw, sh); continue; }
        if (this.missing.has(key)) {
          if (bg) { ctx.fillStyle = bg; ctx.fillRect(sx0, sy0, sw, sh); }
          continue;
        }
        this.request(z, tx, ty, v);
        // 読み込み中は、もっと粗いレベルのタイルで仮に表示する（穴があかない）
        let drawn = false;
        for (let zz = z + 1; zz <= this.Z && !drawn; zz++) {
          const f = 2 ** (zz - z), ptx = Math.floor(tx / f), pty = Math.floor(ty / f);
          const pb = this.get(`${zz}/${ptx}_${pty}`);
          if (!pb) continue;
          const px = (tx - ptx * f) * T / f, py = (ty - pty * f) * T / f;
          ctx.drawImage(pb, px, py, tw / f, th / f, sx0, sy0, sw, sh);
          drawn = true;
        }
        if (!drawn) {
          if (bg) { ctx.fillStyle = bg; ctx.globalAlpha = 0.25; ctx.fillRect(sx0, sy0, sw, sh); ctx.globalAlpha = 1; }
          // 粗いタイルも先に読んでおく
          if (z < this.Z) this.request(z + 1, Math.floor(tx / 2), Math.floor(ty / 2), v);
        }
      }
    }
  }

  dispose() {
    this.alive = false;
    for (const b of this.cache?.values() || []) b.close?.();
    this.cache?.clear();
    this.levels = [];
    this.zip = null;
  }
}
