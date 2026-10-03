// 大きな画像を地図のように拡大縮小して見るビューア（ドラッグ移動・ピンチ・ホイール・ダブルタップ・慣性）
// 1枚の画像のほか、分割保存（タイル形式 .zip）も継ぎ目なく見られる。
import { BitmapSource, TiledSource } from './viewer-sources.js';
import { isZip } from './tiles.js';

export class ImageViewer {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.onChange = onChange;
    this.source = null;
    this.w = 0; this.h = 0;
    this.s = 1; this.ox = 0; this.oy = 0;   // 表示倍率（CSS px / 画像 px）と画像左上の画面位置
    this.pointers = new Map();
    this.vel = { x: 0, y: 0 };
    this.anim = null;
    this.raf = 0;
    this._bind();
    new ResizeObserver(() => { if (this.source) { this.resize(); } }).observe(canvas);
  }

  // テスト・外部から参照できるよう従来の名前を残す
  get img() { return this.source ? (this.source.img || this.source) : null; }
  get levels() { return this.source?.levels || []; }
  get tiled() { return this.source instanceof TiledSource; }

  get cw() { return this.canvas.clientWidth; }
  get ch() { return this.canvas.clientHeight; }
  get fitScale() { return Math.min(this.cw / this.w, this.ch / this.h); }
  get minScale() { return Math.min(this.fitScale, 1) * 0.8; }
  get maxScale() { return Math.max(8, this.fitScale * 4); }

  async load(blob) {
    this.dispose();
    const src = (await isZip(blob)) ? new TiledSource() : new BitmapSource();
    try {
      await src.open(blob);
    } catch (e) {
      src.dispose?.();
      throw e;
    }
    this.source = src;
    this.w = src.w; this.h = src.h;
    this.resize();
    this.fit(false);
  }

  requestDraw() {
    if (this._drawPending) return;
    this._drawPending = true;
    requestAnimationFrame(() => { this._drawPending = false; this.draw(); });
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.anim = null;
    this.source?.dispose();
    this.source = null;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = Math.round(this.cw * dpr);
    this.canvas.height = Math.round(this.ch * dpr);
    this.clamp();
    this.draw();
  }

  fit(animate = true) {
    const s = this.fitScale;
    this.setView(s, (this.cw - this.w * s) / 2, (this.ch - this.h * s) / 2, animate);
  }

  actualSize() { this.zoomTo(1 / (this.dpr || 1), this.cw / 2, this.ch / 2); } // 画像1pxが画面の物理1px

  // 画面の点 (px,py) を動かさずに倍率を s にする
  zoomTo(s, px, py, animate = true) {
    s = Math.min(this.maxScale, Math.max(this.minScale, s));
    const ix = (px - this.ox) / this.s, iy = (py - this.oy) / this.s;
    this.setView(s, px - ix * s, py - iy * s, animate);
  }

  zoomBy(f, px = this.cw / 2, py = this.ch / 2) { this.zoomTo(this.s * f, px, py); }

  setView(s, ox, oy, animate = false) {
    if (!animate) { this.s = s; this.ox = ox; this.oy = oy; this.clamp(); this.draw(); return; }
    this.vel = { x: 0, y: 0 };
    this.anim = { t0: performance.now(), dur: 220, s0: this.s, ox0: this.ox, oy0: this.oy, s1: s, ox1: ox, oy1: oy };
    this.tick();
  }

  // 画像が画面から完全に外れないようにする（小さいときは中央に寄せる）
  clamp() {
    const m = 60;
    const iw = this.w * this.s, ih = this.h * this.s;
    if (iw <= this.cw) this.ox = (this.cw - iw) / 2;
    else this.ox = Math.min(m, Math.max(this.cw - iw - m, this.ox));
    if (ih <= this.ch) this.oy = (this.ch - ih) / 2;
    else this.oy = Math.min(m, Math.max(this.ch - ih - m, this.oy));
  }

  tick() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((now) => {
      let more = false;
      if (this.anim) {
        const a = this.anim, p = Math.min(1, (now - a.t0) / a.dur), e = 1 - Math.pow(1 - p, 3);
        // 倍率は対数で補間（ズームが滑らかに見える）
        this.s = Math.exp(Math.log(a.s0) + (Math.log(a.s1) - Math.log(a.s0)) * e);
        this.ox = a.ox0 + (a.ox1 - a.ox0) * e;
        this.oy = a.oy0 + (a.oy1 - a.oy0) * e;
        if (p >= 1) this.anim = null; else more = true;
      } else if (Math.hypot(this.vel.x, this.vel.y) > 0.05) {
        this.ox += this.vel.x * 16; this.oy += this.vel.y * 16;   // 慣性（px/ms × 16ms）
        this.vel.x *= 0.94; this.vel.y *= 0.94;
        more = true;
      }
      this.clamp();
      this.draw();
      if (more) this.tick();
    });
  }

  draw() {
    if (!this.source) return;
    const dpr = this.dpr || 1, ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0f12';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.source.draw(ctx, this);
    this.onChange?.({ scale: this.s, sEff: this.s * dpr, fit: this.fitScale, w: this.w, h: this.h, tiled: this.tiled });
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none';
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    let lastTap = 0, lastTapPos = null;

    c.addEventListener('pointerdown', (e) => {
      if (!this.source) return;
      c.setPointerCapture(e.pointerId);
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      this.anim = null;
      this.vel = { x: 0, y: 0 };
      this.moved = this.pointers.size > 1;
      this.track = { t: performance.now(), p };
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = pos(e), prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size >= 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.ox += m.x - this.pinch.m.x; this.oy += m.y - this.pinch.m.y;
        const s = Math.min(this.maxScale, Math.max(this.minScale * 0.8, this.s * d / this.pinch.d));
        const ix = (m.x - this.ox) / this.s, iy = (m.y - this.oy) / this.s;
        this.s = s; this.ox = m.x - ix * s; this.oy = m.y - iy * s;
        this.pinch = { d, m };
        this.moved = true;
        this.draw();
        return;
      }
      if (Math.hypot(p.x - this.track.p.x, p.y - this.track.p.y) > 6) this.moved = true;
      this.ox += p.x - prev.x; this.oy += p.y - prev.y;
      // 速度（px/ms）を滑らかに更新
      const now = performance.now(), dt = Math.max(1, now - this.track.t);
      this.vel = { x: 0.7 * this.vel.x + 0.3 * (p.x - prev.x) / dt, y: 0.7 * this.vel.y + 0.3 * (p.y - prev.y) / dt };
      this.track.t = now;
      this.clamp();
      this.draw();
    });

    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = pos(e);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 1) { this.vel = { x: 0, y: 0 }; return; }
      if (this.pointers.size > 0) return;
      // ピンチ後は倍率の下限・上限に戻す
      if (this.s < this.minScale) { this.zoomTo(this.minScale, this.cw / 2, this.ch / 2); return; }
      if (!this.moved) {
        const now = performance.now();
        if (now - lastTap < 320 && lastTapPos && Math.hypot(p.x - lastTapPos.x, p.y - lastTapPos.y) < 30) {
          // ダブルタップ：全体表示 ⇄ 拡大
          lastTap = 0;
          if (this.s > this.fitScale * 1.5) this.fit(); else this.zoomTo(Math.max(this.fitScale * 3, 1 / (this.dpr || 1)), p.x, p.y);
        } else { lastTap = now; lastTapPos = p; }
        return;
      }
      if (performance.now() - this.track.t < 80 && Math.hypot(this.vel.x, this.vel.y) > 0.1) this.tick();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      if (!this.source) return;
      e.preventDefault();
      const p = pos(e);
      this.anim = null;
      if (e.shiftKey) { this.ox -= e.deltaY; this.clamp(); this.draw(); return; }
      const k = e.deltaMode ? 0.05 : (e.ctrlKey ? 0.01 : 0.0016);
      const s = Math.min(this.maxScale, Math.max(this.minScale, this.s * Math.exp(-e.deltaY * k)));
      const ix = (p.x - this.ox) / this.s, iy = (p.y - this.oy) / this.s;
      this.s = s; this.ox = p.x - ix * s; this.oy = p.y - iy * s;
      this.clamp();
      this.draw();
    }, { passive: false });

    c.addEventListener('dblclick', (e) => {
      if (!this.source || e.pointerType === 'touch') return;
      const p = pos(e);
      if (this.s > this.fitScale * 1.5) this.fit(); else this.zoomTo(Math.max(this.fitScale * 3, 1 / (this.dpr || 1)), p.x, p.y);
    });

    window.addEventListener('keydown', (e) => {
      if (!this.source || this.canvas.offsetParent === null) return;
      if (e.key === '+' || e.key === '=') this.zoomBy(1.5);
      else if (e.key === '-') this.zoomBy(1 / 1.5);
      else if (e.key === '0') this.fit();
      else if (e.key === 'ArrowLeft') { this.ox += 80; this.clamp(); this.draw(); }
      else if (e.key === 'ArrowRight') { this.ox -= 80; this.clamp(); this.draw(); }
      else if (e.key === 'ArrowUp') { this.oy += 80; this.clamp(); this.draw(); }
      else if (e.key === 'ArrowDown') { this.oy -= 80; this.clamp(); this.draw(); }
    });
  }
}
