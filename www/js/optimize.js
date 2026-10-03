// 全体の位置の最適化（バンドル調整のような最小二乗）
// 取り込み時、新しいコマは近くの複数のタイルと位置合わせされる。そのとき測った「タイル同士の相対位置」を
// tile.links = [{ id, dx, dy, w }]（このタイルの位置 − タイル id の位置 ≒ (dx, dy)、w は確からしさ）として覚えておき、
// 全部の測定にできるだけ矛盾しないよう、全タイルの位置をいっぺんに直す。
// 一本道で少しずつずれが溜まっても、ぐるっと回って元の場所に戻ったとき（ループ）や、追加動画で同じ所を通ったときに、
// ずれが全体に分散して小さくなる。AI は使わず、画像の再解析もしない（測定済みの値だけで解くので速い）。

const LAMBDA = 0.02;   // 今の位置にとどまろうとする弱い力（測定がないタイルが動かないように）

export function linkWeight(score, weak) {
  const w = Math.min(1, Math.max(0.05, (score - 0.4) / 0.5));
  return weak ? w * 0.3 : w;
}

function collect(mosaic) {
  const byId = new Map();
  for (const t of mosaic.placed()) byId.set(t.id, t);
  const edges = [];
  for (const t of byId.values()) {
    for (const l of t.links || []) {
      const o = byId.get(l.id);
      if (o && o !== t) edges.push({ a: o, b: t, dx: l.dx, dy: l.dy, w: l.w });
    }
  }
  return edges;
}

export function linkResidual(mosaic) {
  const edges = collect(mosaic);
  if (!edges.length) return { n: 0, rms: 0, max: 0 };
  let s = 0, sw = 0, max = 0;
  for (const e of edges) {
    const rx = (e.b.x - e.a.x) - e.dx, ry = (e.b.y - e.a.y) - e.dy;
    s += e.w * (rx * rx + ry * ry); sw += e.w;
    max = Math.max(max, Math.hypot(rx, ry));
  }
  return { n: edges.length, rms: Math.sqrt(s / sw), max };
}

// 戻り値: { n, before, after, moved, maxMove, undo }。条件を満たさなければ位置は変えない
export function optimizePositions(mosaic, { minGain = 0.2, maxMove = 40, dry = false } = {}) {
  const edges = collect(mosaic);
  const before = linkResidual(mosaic);
  if (edges.length < 2) return { n: edges.length, before, after: before, moved: 0, maxMove: 0, applied: false };
  const tiles = [...new Set(edges.flatMap((e) => [e.a, e.b]))];
  const idx = new Map(tiles.map((t, i) => [t, i]));
  const px = Float64Array.from(tiles, (t) => t.x), py = Float64Array.from(tiles, (t) => t.y);
  const x0 = px.slice(), y0 = py.slice();
  const adj = tiles.map(() => []);
  for (const e of edges) {
    const i = idx.get(e.a), j = idx.get(e.b);
    adj[i].push({ j, dx: -e.dx, dy: -e.dy, w: e.w });   // p_i = p_j - d  （e: p_j' - p_i = d）
    adj[j].push({ j: i, dx: e.dx, dy: e.dy, w: e.w });  // p_j = p_i + d
  }
  for (let it = 0; it < 600; it++) {
    let delta = 0;
    for (let i = 0; i < tiles.length; i++) {
      let sx = LAMBDA * x0[i], sy = LAMBDA * y0[i], sw = LAMBDA;
      for (const o of adj[i]) { sx += o.w * (px[o.j] + o.dx); sy += o.w * (py[o.j] + o.dy); sw += o.w; }
      const nx = sx / sw, ny = sy / sw;
      delta = Math.max(delta, Math.abs(nx - px[i]), Math.abs(ny - py[i]));
      px[i] = nx; py[i] = ny;
    }
    if (delta < 0.005) break;
  }
  // 整数の位置にして評価する（タイルの位置は整数で持つ）
  const nxs = Array.from(px, Math.round), nys = Array.from(py, Math.round);
  let mv = 0, moved = 0;
  for (let i = 0; i < tiles.length; i++) {
    const m = Math.hypot(nxs[i] - tiles[i].x, nys[i] - tiles[i].y);
    mv = Math.max(mv, m); if (m >= 1) moved++;
  }
  const prev = tiles.map((t) => [t, t.x, t.y]);
  for (let i = 0; i < tiles.length; i++) { tiles[i].x = nxs[i]; tiles[i].y = nys[i]; }
  const after = linkResidual(mosaic);
  const ok = moved > 0 && mv <= maxMove && after.rms <= before.rms * (1 - minGain);
  if (!ok || dry) for (const [t, x, y] of prev) { t.x = x; t.y = y; }
  else mosaic.changed();
  return {
    n: edges.length, before, after, moved: ok ? moved : 0, maxMove: mv, applied: ok && !dry,
    undo: ok && !dry ? () => { for (const [t, x, y] of prev) { t.x = x; t.y = y; } mosaic.changed(); } : null,
  };
}

// 手で動かしたタイルの測定は古くなるので捨てる
export function dropLinks(mosaic, tile) {
  tile.links = null;
  for (const t of mosaic.tiles) if (t.links) t.links = t.links.filter((l) => l.id !== tile.id);
}
