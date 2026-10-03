// 「記録しない領域（マスク）」：画面の真ん中のポインターやキャラクターのように、
// 地図が動いても画面の同じ位置に居続ける物を、記録しないための道具。
//
// 仕組み
//  - マスクは、切り抜いたコマに対する割合で持つ { on, shape: 'ellipse' | 'rect', cx, cy, rw, rh }
//  - 位置合わせ用の濃淡画像では、マスクの中を周囲の平均色でならす（動かない物があると「動いていない」と誤認するため）
//  - タイルの画像は、マスクの中を透明にして保存する（取り込み済みの下の画像や、次のコマの画像が見える）
//  - タイルにはマスクの位置を残し、「覆われている範囲」の計算ではマスクの中を除く
//    → 物の下に隠れていた所は、次のコマ以降で動いて見えた絵で埋まる

export const DEFAULT_MASK = { on: false, shape: 'ellipse', cx: 0.5, cy: 0.5, rw: 0.12, rh: 0.07 };

// 割合 → ピクセル（周囲のにじみを含めて少し広げる）
export function maskPx(mask, w, h, pad = null) {
  const p = pad ?? Math.max(3, Math.round(Math.min(w, h) * 0.008));
  const cx = mask.cx * w, cy = mask.cy * h;
  const rx = mask.rw * w + p, ry = mask.rh * h + p;
  return { shape: mask.shape, cx, cy, rx, ry, x: Math.max(0, Math.floor(cx - rx)), y: Math.max(0, Math.floor(cy - ry)),
    w: Math.min(w, Math.ceil(cx + rx)) - Math.max(0, Math.floor(cx - rx)), h: Math.min(h, Math.ceil(cy + ry)) - Math.max(0, Math.floor(cy - ry)) };
}

// 点 (x, y)（コマの座標）がマスクの中か
export function inMask(m, x, y) {
  if (!m) return false;
  if (m.shape === 'rect') return x >= m.cx - m.rx && x < m.cx + m.rx && y >= m.cy - m.ry && y < m.cy + m.ry;
  const dx = (x - m.cx) / m.rx, dy = (y - m.cy) / m.ry;
  return dx * dx + dy * dy <= 1;
}

// 行 y でマスクが占める x の範囲 [x0, x1)（なければ null）
export function maskSpan(m, y) {
  if (!m) return null;
  const dy = (y - m.cy) / m.ry;
  if (m.shape === 'rect') return y >= m.cy - m.ry && y < m.cy + m.ry ? [m.cx - m.rx, m.cx + m.rx] : null;
  if (Math.abs(dy) > 1) return null;
  const d = m.rx * Math.sqrt(1 - dy * dy);
  return [m.cx - d, m.cx + d];
}

// 濃淡画像のマスクの中を、マスクのすぐ外側の平均でならす
export function flattenGray(gray, w, h, m) {
  if (!m) return;
  let s = 0, n = 0;
  const x0 = Math.max(0, m.x - 4), x1 = Math.min(w, m.x + m.w + 4), y0 = Math.max(0, m.y - 4), y1 = Math.min(h, m.y + m.h + 4);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!inMask(m, x + 0.5, y + 0.5)) { s += gray[y * w + x]; n++; }
  const v = n ? Math.round(s / n) : 128;
  for (let y = m.y; y < m.y + m.h; y++) for (let x = m.x; x < m.x + m.w; x++) if (inMask(m, x + 0.5, y + 0.5)) gray[y * w + x] = v;
}

// キャンバスのマスクの中を透明にする
export function punchMask(ctx, m) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  ctx.beginPath();
  if (m.shape === 'rect') ctx.rect(m.cx - m.rx, m.cy - m.ry, m.rx * 2, m.ry * 2);
  else ctx.ellipse(m.cx, m.cy, m.rx, m.ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// タイル t を、格子（原点 (ox,oy)、セル cell）に塗る。マスクの中は塗らない。
// 戻り値なし。g は Uint8Array(gw*gh)
export function fillTileCells(g, gw, gh, ox, oy, cell, t) {
  const i0 = Math.max(0, Math.ceil((t.x - ox) / cell - 0.5)), i1 = Math.min(gw - 1, Math.floor((t.x + t.w - ox) / cell - 0.5));
  const j0 = Math.max(0, Math.ceil((t.y - oy) / cell - 0.5)), j1 = Math.min(gh - 1, Math.floor((t.y + t.h - oy) / cell - 0.5));
  if (i1 < i0 || j1 < j0) return;
  for (let j = j0; j <= j1; j++) {
    const row = j * gw;
    if (!t.mask) { g.fill(1, row + i0, row + i1 + 1); continue; }
    const span = maskSpan(t.mask, oy + (j + 0.5) * cell - t.y);
    if (!span) { g.fill(1, row + i0, row + i1 + 1); continue; }
    // マスクの範囲（グリッド座標）を除いて塗る
    const a = Math.ceil((t.x + span[0] - ox) / cell - 0.5), b = Math.floor((t.x + span[1] - ox) / cell - 0.5);
    if (a > i0) g.fill(1, row + i0, row + Math.min(a - 1, i1) + 1);
    if (b < i1) g.fill(1, row + Math.max(b + 1, i0), row + i1 + 1);
  }
}
