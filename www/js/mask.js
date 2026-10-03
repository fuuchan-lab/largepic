// 「記録しない領域（マスク）」：画面の真ん中のポインターやキャラクター、縮尺（スケール）バー、アイコンなど、
// 地図が動いても画面の同じ位置に居続ける物を、記録しないための道具。複数の領域を指定できる。
//
// 仕組み
//  - マスクは、切り抜いたコマに対する割合で持つ { shape: 'ellipse' | 'rect', cx, cy, rw, rh }。リストで複数持てる
//  - 位置合わせ用の濃淡画像では、マスクの中を周囲の平均色でならす（動かない物があると「動いていない」と誤認するため）
//  - タイルの画像は、マスクの中を透明にして保存する（取り込み済みの下の画像や、次のコマの画像が見える）
//  - タイルにはマスクの位置を残し、「覆われている範囲」の計算ではマスクの中を除く
//    → 物の下に隠れていた所は、次のコマ以降で動いて見えた絵で埋まる

export const DEFAULT_MASK = { shape: 'ellipse', cx: 0.5, cy: 0.5, rw: 0.12, rh: 0.07 };

// 設定・保存データの形をそろえる：旧形式（1つだけ { on, ... }）も、新形式（配列）も、配列にする
export function normalizeMasks(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : (v.on ? [v] : []);
  return list.filter((m) => m && m.rw > 0 && m.rh > 0 && m.on !== false)
    .map((m) => ({ shape: m.shape === 'rect' ? 'rect' : 'ellipse', cx: +m.cx, cy: +m.cy, rw: +m.rw, rh: +m.rh }));
}

// 割合 → ピクセル（周囲のにじみを含めて少し広げる）
export function maskPx(mask, w, h, pad = null) {
  const p = pad ?? Math.max(3, Math.round(Math.min(w, h) * 0.008));
  const cx = mask.cx * w, cy = mask.cy * h;
  const rx = mask.rw * w + p, ry = mask.rh * h + p;
  const x = Math.max(0, Math.floor(cx - rx)), y = Math.max(0, Math.floor(cy - ry));
  return { shape: mask.shape, cx, cy, rx, ry, x, y, w: Math.min(w, Math.ceil(cx + rx)) - x, h: Math.min(h, Math.ceil(cy + ry)) - y };
}
export function maskPxList(masks, w, h, pad = null) {
  return normalizeMasks(masks).map((m) => maskPx(m, w, h, pad));
}

// 点 (x, y)（コマの座標）が、このマスクの中か
export function inMask(m, x, y) {
  if (!m) return false;
  if (m.shape === 'rect') return x >= m.cx - m.rx && x < m.cx + m.rx && y >= m.cy - m.ry && y < m.cy + m.ry;
  const dx = (x - m.cx) / m.rx, dy = (y - m.cy) / m.ry;
  return dx * dx + dy * dy <= 1;
}
// マスクのどれかの中か
export function inAny(ms, x, y) {
  if (!ms) return false;
  for (const m of ms) if (inMask(m, x, y)) return true;
  return false;
}

// 行 y でマスクが占める x の範囲 [x0, x1)（なければ null）
export function maskSpan(m, y) {
  const dy = (y - m.cy) / m.ry;
  if (m.shape === 'rect') return y >= m.cy - m.ry && y < m.cy + m.ry ? [m.cx - m.rx, m.cx + m.rx] : null;
  if (Math.abs(dy) > 1) return null;
  const d = m.rx * Math.sqrt(1 - dy * dy);
  return [m.cx - d, m.cx + d];
}
// 行 y で、いくつかのマスクが占める範囲を、重なりをまとめて小さい順に返す
export function maskSpans(ms, y) {
  const spans = [];
  for (const m of ms || []) { const s = maskSpan(m, y); if (s) spans.push(s); }
  spans.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const s of spans) {
    if (out.length && s[0] <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

// 濃淡画像のマスクの中を、マスクのすぐ外側の平均でならす（複数のマスクをすべて）
export function flattenGray(gray, w, h, ms) {
  for (const m of ms || []) {
    let s = 0, n = 0;
    const x0 = Math.max(0, m.x - 4), x1 = Math.min(w, m.x + m.w + 4), y0 = Math.max(0, m.y - 4), y1 = Math.min(h, m.y + m.h + 4);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!inAny(ms, x + 0.5, y + 0.5)) { s += gray[y * w + x]; n++; }
    const v = n ? Math.round(s / n) : 128;
    for (let y = m.y; y < m.y + m.h; y++) for (let x = m.x; x < m.x + m.w; x++) if (inMask(m, x + 0.5, y + 0.5)) gray[y * w + x] = v;
  }
}

// キャンバスのマスクの中を透明にする
export function punchMask(ctx, ms) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  for (const m of ms || []) {
    ctx.beginPath();
    if (m.shape === 'rect') ctx.rect(m.cx - m.rx, m.cy - m.ry, m.rx * 2, m.ry * 2);
    else ctx.ellipse(m.cx, m.cy, m.rx, m.ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// タイル t を、格子（原点 (ox,oy)、セル cell）に塗る。t.masks（タイルの座標のマスク）の中は塗らない。
// g は Uint8Array(gw*gh)
export function fillTileCells(g, gw, gh, ox, oy, cell, t) {
  // 保存してある画像の範囲（フレームの一部だけ保存していることがある）。マスクはフレームの座標
  const rx = t.x + (t.ix || 0), ry = t.y + (t.iy || 0), rw = t.iw ?? t.w, rh = t.ih ?? t.h;
  const i0 = Math.max(0, Math.ceil((rx - ox) / cell - 0.5)), i1 = Math.min(gw - 1, Math.floor((rx + rw - ox) / cell - 0.5));
  const j0 = Math.max(0, Math.ceil((ry - oy) / cell - 0.5)), j1 = Math.min(gh - 1, Math.floor((ry + rh - oy) / cell - 0.5));
  if (i1 < i0 || j1 < j0) return;
  for (let j = j0; j <= j1; j++) {
    const row = j * gw;
    const spans = t.masks && t.masks.length ? maskSpans(t.masks, oy + (j + 0.5) * cell - t.y) : [];
    if (!spans.length) { g.fill(1, row + i0, row + i1 + 1); continue; }
    // マスクの範囲（グリッド座標）を除いて塗る
    let from = i0;
    for (const sp of spans) {
      const a = Math.ceil((t.x + sp[0] - ox) / cell - 0.5), b = Math.floor((t.x + sp[1] - ox) / cell - 0.5);
      if (b < from || a > i1) continue;
      if (a > from) g.fill(1, row + from, row + Math.min(a - 1, i1) + 1);
      from = Math.max(from, b + 1);
    }
    if (from <= i1) g.fill(1, row + from, row + i1 + 1);
  }
}
