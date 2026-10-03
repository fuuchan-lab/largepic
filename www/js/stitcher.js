// 新しい画像（フレーム）をモザイクのどこに置くかを決める
import { makeFeatures, register, registerNear, coarseMatch, diagnoseTransform, ncc, scalesFor } from './register.js';
import { makeThumb, canvasToBlob, nextFrame } from './imageutil.js';

const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

export class Stitcher {
  constructor(mosaic, settings) {
    this.mosaic = mosaic;
    this.settings = settings;
    this.scales = null;
  }

  get threshold() { return this.settings.threshold; }

  features(frame) {
    if (!this.scales || !this.mosaic.tiles.length) this.scales = scalesFor(frame.w, frame.h);
    return makeFeatures(frame.gray, frame.w, frame.h, this.scales);
  }

  // frame.canvas の内容からタイルを作る。srcBlob があればそれを元画像として使う
  async makeTile(frame, feat, srcBlob, x, y, placed) {
    let src = srcBlob, sx = frame.rect.sx, sy = frame.rect.sy;
    if (!src) {
      src = await canvasToBlob(frame.canvas, 'image/png', 1);
      sx = 0; sy = 0;
    }
    const { bmp, scale } = await makeThumb(frame.canvas, frame.w, frame.h, this.settings.thumbSize);
    const tile = { x, y, w: frame.w, h: frame.h, placed, thumb: bmp, thumbScale: scale, src, sx, sy, feat };
    this.mosaic.add(tile);
    this.mosaic.touchFullGray(tile);
    return tile;
  }

  // 既存タイル（order の順）に対して feat の位置を探す
  // タイルが多いときは、粗い解像度で全部を素早く採点してから有望なものだけ詰める
  async locate(feat, order) {
    order = order.filter((t) => t.placed);
    if (order.length > 3) {
      const scored = [];
      for (let i = 0; i < order.length; i++) {
        const c = coarseMatch(order[i].feat, feat);
        if (c && c.score > 0.25) scored.push({ t: order[i], s: c.score });
        if (i % 8 === 7) await nextFrame();
      }
      scored.sort((p, q) => q.s - p.s);
      order = scored.slice(0, 3).map((o) => o.t);
    }
    let best = null;
    for (const t of order) {
      await this.mosaic.ensureFullGray(t);
      const r = register(t.feat, feat);
      if (r && r.score >= this.threshold && r.overlap >= 0.12 && (!best || r.score > best.score)) {
        best = { x: t.x + r.dx, y: t.y + r.dy, score: r.score, tile: t };
        if (r.score > 0.85) break;
      }
      await nextFrame();
    }
    return best;
  }

  // 矩形と重なっている配置済みタイル（重なりの大きい順）
  overlapping(x, y, w, h) {
    const rect = { x, y, w, h };
    return this.mosaic.placed()
      .map((t) => ({ t, a: overlapArea(rect, t) }))
      .filter((o) => o.a > 0.05 * w * h)
      .sort((p, q) => q.a - p.a)
      .map((o) => o.t);
  }

  // 位置 (x,y) に置くと、重なる既存タイルと絵が食い違う（矛盾する）か調べる。
  // 重なり部分に十分な模様があるのに相関が低いときだけ矛盾とみなす（無地の海などでは判断しない）。
  conflictAt(feat, x, y) {
    const rect = { x, y, w: feat.w, h: feat.h };
    const list = this.mosaic.placed()
      .map((t) => ({ t, a: overlapArea(rect, t) }))
      .filter((o) => o.a > 0.12 * feat.w * feat.h)
      .sort((p, q) => q.a - p.a)
      .slice(0, 4);
    let worst = null;
    for (const { t } of list) {
      const k = t.feat.mid.scale;
      const r = ncc(t.feat.mid, feat.mid, Math.round((x - t.x) * k), Math.round((y - t.y) * k), 1);
      if (r.overlap >= 0.12 && r.texture >= 12 && r.raw < this.settings.conflictBelow) {
        if (!worst || r.raw < worst.score) worst = { score: r.raw, tile: t };
      }
    }
    return worst;
  }

  // 位置 (x,y) 付近で、重なっている既存タイルとの位置合わせを詰める
  async refineAt(feat, x, y, radius, exclude = null) {
    const rect = { x, y, w: feat.w, h: feat.h };
    const others = this.mosaic.placed()
      .filter((t) => t !== exclude)
      .map((t) => ({ t, a: overlapArea(rect, t) }))
      .filter((o) => o.a > 0.03 * feat.w * feat.h)
      .sort((p, q) => q.a - p.a)
      .slice(0, 3);
    let best = null;
    for (const { t } of others) {
      await this.mosaic.ensureFullGray(t);
      let r = registerNear(t.feat, feat, x - t.x, y - t.y, radius);
      if (r && r.score >= this.threshold * 0.9 && (r.dx !== x - t.x || r.dy !== y - t.y)) {
        // 今の位置とほとんど変わらない程度の改善なら、位置を動かさない
        // （海のように模様が少ない所では、探すほど偶然よい点が見つかって位置が飛ぶため）
        const lv = (t.feat.full && feat.full) ? 'full' : 'mid';
        const base = ncc(t.feat[lv], feat[lv], Math.round((x - t.x) * t.feat[lv].scale), Math.round((y - t.y) * t.feat[lv].scale), lv === 'full' ? 3 : 1);
        if (base.score > 0 && r.score - base.score < 0.03) r = { dx: x - t.x, dy: y - t.y, score: Math.max(base.score, r.score - 0.03) };
      }
      if (r && r.score >= this.threshold * 0.9 && (!best || r.score > best.score)) {
        best = { x: t.x + r.dx, y: t.y + r.dy, score: r.score };
      }
    }
    return best;
  }

  // スクリーンショット1枚を追加
  async addStill(frame, srcBlob) {
    const feat = this.features(frame);
    const placed = this.mosaic.placed();
    if (!placed.length) {
      await this.makeTile(frame, feat, srcBlob, 0, 0, true);
      return 'first';
    }
    const order = [...placed].sort((a, b) => b.id - a.id); // 新しい順
    const hit = await this.locate(feat, order);
    if (hit) {
      await this.makeTile(frame, feat, srcBlob, hit.x, hit.y, true);
      return 'placed';
    }
    const bb = this.mosaic.bbox(true);
    await this.makeTile(frame, feat, srcBlob, bb.x + bb.w + 60, bb.y, false);
    return 'unplaced';
  }

  // 手で動かしたタイルを周囲にピタッと合わせる
  async snap(tile) {
    await this.mosaic.ensureFullGray(tile);
    const radius = Math.max(80, 0.25 * Math.min(tile.w, tile.h));
    const hit = await this.refineAt(tile.feat, tile.x, tile.y, radius, tile);
    if (!hit) return false;
    tile.x = hit.x; tile.y = hit.y; tile.placed = true;
    this.mosaic.changed();
    return true;
  }

  // 周囲のどこかに合う場所がないか全体から探す
  async autoPlace(tile) {
    await this.mosaic.ensureFullGray(tile);
    const order = this.mosaic.placed().filter((t) => t !== tile).sort((a, b) => b.id - a.id);
    const hit = await this.locate(tile.feat, order);
    if (!hit) return false;
    tile.x = hit.x; tile.y = hit.y; tile.placed = true;
    this.mosaic.changed();
    return true;
  }
}

// 動画・画面キャプチャの連続フレームを追跡して、未取得の範囲に来たらタイルを追加する
// スクロール中のコマはブレやすいので、止まったコマを優先して取り込む
export class Tracker {
  constructor(stitcher) {
    this.st = stitcher;
    this.mosaic = stitcher.mosaic;
    this.ref = null;
    this.pos = null;
    this.vel = null;
    this.lost = true;
    this.stats = { added: 0, lost: 0, frames: 0 };
    this.posHistory = [];  // 位置履歴（整合性チェック用）
    this.ignoreConflicts = 0;
    this.tf = { hits: 0, last: null, lostFrames: 0 };  // 回転・拡大率の変化の検出状況
  }

  // feat と ref のあいだに回転・拡大率の違いがあれば記録する。2回続けて見つかったら true
  checkTransform(ref, feat) {
    let d = null;
    try { d = diagnoseTransform(ref, feat); } catch (e) { console.warn(e); }
    if (d && feat === this.tf.lastFeat) return this.tf.hits >= 2;  // 同じコマの別の相手との照合は1回と数える
    if (d) {
      this.tf.lastFeat = feat;
      // 別々のコマで2回続けて「同じ回転・拡大率」が見つかったときだけ本物とみなす（偶然の一致で止めない）
      const l = this.tf.last;
      const same = l && Math.abs(Math.abs(d.angle) - Math.abs(l.angle)) < 6
        && Math.abs(Math.log(d.scale) - Math.log(l.scale)) < 0.08;
      this.tf.hits = same ? this.tf.hits + 1 : 1;
      this.tf.last = d;
    }
    return this.tf.hits >= 2;
  }

  // 位置合わせに成功した（＝回転や拡大率の変化ではなかった）ので、疑いをリセット
  clearTransform() { this.tf.hits = 0; this.tf.lostFrames = 0; }

  transformResult(rect) {
    const d = this.tf.last;
    return { state: 'transform', rect, angle: d.angle, scale: d.scale };
  }

  get addThreshold() { return this.st.settings.addUncovered; }

  // opts.final: 最後のフレーム（少しでも未取得部分があれば取り込む）
  async process(frame, opts = {}) {
    const st = this.st;
    const feat = st.features(frame);
    const rectAt = (p) => (p ? { x: p.x, y: p.y, w: frame.w, h: frame.h } : null);
    this.stats.frames++;

    if (!this.mosaic.placed().length) {
      // 最初の1枚は「同じ画面が続けて追跡でき、実際にスクロールされた」ことを確認してから確定する
      // （収録開始直後のこのアプリの画面や、アプリ切り替え中の画面を取り込まないため）
      if (this.cand) {
        const r = register(this.cand, feat);
        if (r && r.score >= st.threshold) { this.chain++; this.chainMove += Math.hypot(r.dx, r.dy); }
        else { this.chain = 0; this.chainMove = 0; }
      } else { this.chain = 0; this.chainMove = 0; }
      this.cand = feat;
      const small = Math.min(frame.w, frame.h);
      if (!(opts.final || opts.immediate || opts.key || (this.chain >= 2 && this.chainMove > small * 0.03))) {
        return { state: 'waiting', rect: null };
      }
      const t0 = await st.makeTile(frame, feat, null, 0, 0, true);
      t0.vt = opts.vt;
      if (opts.kpos) this.kAnchor = { kx: opts.kpos.x, ky: opts.kpos.y, px: 0, py: 0 };
      this.ref = feat; this.pos = { x: 0, y: 0 }; this.lost = false; this.vel = null; this.cand = null;
      this.stats.added++;
      return { state: 'added', rect: rectAt(this.pos) };
    }

    if (opts.newSeg) { this.lost = true; this.ref = null; this.vel = null; this.kAnchor = null; }  // 解析で途切れた所：取り込み済みの場所から探し直す
    let motion = Infinity;
    if (!this.lost && this.ref) {
      const small = Math.min(frame.w, frame.h);
      const hint = opts.hint || this.vel || undefined;
      const fastScroll = hint && Math.hypot(hint.dx, hint.dy) > small * 0.1;
      let r = register(this.ref, feat, { hint, prior: hint, fastScroll });
      // 事前解析の移動量と大きく食い違い、しかも確信が弱い結果は信用しない
      // （海のように模様が少ない所で、別の場所に吸着してしまうのを防ぐ）
      // 重なりが小さい結果は、偶然の一致でも高い値が出るので採用しない
      if (r && opts.hint) {
        const dev = Math.hypot(r.dx - opts.hint.dx, r.dy - opts.hint.dy);
        if (r.overlap < 0.2 || dev > Math.max(60, small * 0.1) || (r.score < 0.85 && dev > Math.max(40, small * 0.06))) r = null;
      }
      if (r && r.score >= st.threshold) {
        this.lastScore = r.score;
        motion = Math.hypot(r.dx, r.dy);
        this.vel = { dx: r.dx, dy: r.dy };
        this.pos = { x: this.pos.x + r.dx, y: this.pos.y + r.dy };
        this.tf.hits = Math.max(0, this.tf.hits - 1);
        this.ref = feat;
      } else {
        // 直前のコマと平行移動で合わない：速すぎるスクロールのほか、回転・拡大率の変化も疑う
        if (this.checkTransform(this.ref, feat)) return this.transformResult(rectAt(this.pos));
        this.lost = true;
        this.ref = null;
        this.vel = null;
      }
    }

    if (this.lost) {
      // 近い順に並べて全タイルから探す（追加動画で不足部分を埋めるときもここで復帰）
      let order = this.mosaic.placed();
      if (this.pos) order = [...order].sort((a, b) => Math.hypot(a.x - this.pos.x, a.y - this.pos.y) - Math.hypot(b.x - this.pos.x, b.y - this.pos.y));
      let hit = await st.locate(feat, order);
      // 事前解析の経路から期待される位置と大きく違い、確信も弱い結果は信用しない（模様の少ない所で別の場所に合ってしまうため）
      if (hit && this.kAnchor && opts.kpos && !opts.newSeg) {
        const ex = this.kAnchor.px + (opts.kpos.x - this.kAnchor.kx), ey = this.kAnchor.py + (opts.kpos.y - this.kAnchor.ky);
        const sm = Math.min(frame.w, frame.h);
        if (Math.hypot(hit.x - ex, hit.y - ey) > Math.max(60, sm * 0.12)) hit = null;
      }
      if (!hit) {
        this.stats.lost++;
        // 取り込み済みの場所のはずなのに合わない：拡大率や向きが違う可能性（3コマに1回調べる）
        if (opts.key || this.tf.lostFrames++ % 3 === 0) {
          for (const t of order.slice(0, 3)) if (this.checkTransform(t.feat, feat)) return this.transformResult(rectAt(this.pos));
        }
        return { state: 'lost', rect: rectAt(this.pos) };
      }
      this.clearTransform();
      this.pos = { x: hit.x, y: hit.y };
      this.lastScore = hit.score;
      this.ref = feat;
      this.lost = false;
      motion = Infinity;
    }

    if (opts.kpos) this.kAnchor = { kx: opts.kpos.x, ky: opts.kpos.y, px: this.pos.x, py: this.pos.y };
    const { frac: unc, area: uncArea } = this.mosaic.uncoveredArea(this.pos.x, this.pos.y, frame.w, frame.h);
    const small = Math.min(frame.w, frame.h);
    const still = motion <= Math.max(2, small * 0.015);
    const fast = motion > small * 0.08;
    // 止まったコマ：少しでも新しければ取り込む／速く動いているコマ：かなり欠けるまで待つ
    let need = this.addThreshold;
    if (opts.final) need = 0.005;
    else if (opts.key) need = Math.min(need, 0.12);  // 事前解析で選んだコマ：新しい範囲が少しでもあれば取り込む
    else if (still) need = Math.min(0.02, need);
    else if (fast) need = Math.max(need, 0.45);
    // 小さな抜け（穴）も埋める：止まったコマ・選んだコマでは、割合が小さくても一定の面積があれば取り込む
    const hole = (opts.final || opts.key || still) && uncArea >= frame.w * frame.h * 0.001;
    if (unc > need || hole) {
      // 既存タイルと直接合わせ直して誤差の蓄積を防ぐ
      const fix = await st.refineAt(feat, this.pos.x, this.pos.y, 24);
      if (fix) this.pos = { x: fix.x, y: fix.y };
      else if (unc < 0.7) {
        // 既存タイルと十分重なる位置なのに合わない：回転・拡大率の変化を疑う
        const over = st.overlapping(this.pos.x, this.pos.y, frame.w, frame.h)[0];
        if (over && this.checkTransform(over.feat, feat)) return this.transformResult(rectAt(this.pos));
      }

      // 複数フレーム整合性チェック：過去のフレームとの一貫性を確認
      if (this.posHistory.length >= 2) {
        const prev = this.posHistory[this.posHistory.length - 1];
        const prevprev = this.posHistory[this.posHistory.length - 2];
        const expectedDx = prev.x - prevprev.x;
        const expectedDy = prev.y - prevprev.y;
        const actualDx = this.pos.x - prev.x;
        const actualDy = this.pos.y - prev.y;
        const divergence = Math.hypot(actualDx - expectedDx, actualDy - expectedDy);
        // 予想の2倍以上ずれている場合は警告レベルを上げる
        if (divergence > Math.max(8, small * 0.2)) {
          // 信頼度を低下させつつも取り込む（手動調整の対象にする）
        }
      }

      // 位置の確からしさ：既存タイルと直接合わせられたらその値、なければ直前のコマとの値
      const conf = fix ? fix.score : (this.lastScore ?? 0);
      this.posHistory.push({ ...this.pos });
      if (this.posHistory.length > 10) this.posHistory.shift();  // 履歴は最大10フレーム保持

      // 既存の部分と絵が食い違うなら、取り込まずに知らせる（そのまま続けるとずれが広がる）
      if (this.ignoreConflicts > 0) this.ignoreConflicts--;
      else {
        const bad = st.conflictAt(feat, this.pos.x, this.pos.y);
        if (bad) return { state: 'conflict', rect: rectAt(this.pos), score: bad.score };
      }
      const tile = await st.makeTile(frame, feat, null, this.pos.x, this.pos.y, true);
      tile.conf = conf;
      tile.vt = opts.vt;  // 動画の時刻（デバッグ用）
      tile.weak = conf < 0.7 || !fix && this.mosaic.placed().length > 1 && unc < 0.9; // 既存タイルで確かめられなかった
      if (tile.weak) this.stats.weak = (this.stats.weak || 0) + 1;
      this.stats.added++;
      return { state: 'added', rect: rectAt(this.pos) };
    }
    return { state: 'tracking', rect: rectAt(this.pos) };
  }
}
