import { Mosaic } from './mosaic.js';
import { View, drawOverview } from './view.js';
import { Stitcher, Tracker } from './stitcher.js';
import { analyzeVideo, selectKeyframes, makeKeyReader, detectStatic } from './analyze.js';
import { ImageViewer } from './viewer.js';
import { exportTiles } from './tiles.js';
import { library } from './library.js';
import { keepAwake, sleep } from './awake.js';
import { jobs } from './jobs.js';
import { perf } from './perf.js';
import { DEFAULT_MASK } from './mask.js';
import { editCrop, PRESETS } from './cropdialog.js';
import { grabFrame, decodeBitmap, isIOS, isMobile, nextFrame } from './imageutil.js';
import { ProjectStore } from './store.js';
import { computeTrim, TrimEditor } from './trim.js';
import { isNative, nativePlatform, webPlatform, ScreenRecorder, nativeFileToBlob } from './native.js';

const $ = (s) => document.querySelector(s);
const APP = 'largepic';
const APP_VERSION = '2026-10-03.10';  // 画面で確認できる版番号（設定の下）

// ---------- 設定 ----------
const DEFAULTS = {
  threshold: 0.55,
  videoStep: 0.15,
  addUncovered: 0.2,
  conflictBelow: 0.45,   // 重なる部分の相関がこれ未満なら「絵が食い違う」とみなす
  thumbSize: 640,
  bgColor: 'black',
  crops: { image: PRESETS.phone, video: PRESETS.phone, live: PRESETS.desktop },
  mask: { ...DEFAULT_MASK },   // 記録しない領域（ポインター・キャラクターなど、画面の同じ位置に居続ける物）
};
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(APP + '.settings') || '{}');
    return { ...DEFAULTS, ...s, crops: { ...DEFAULTS.crops, ...(s.crops || {}) }, mask: { ...DEFAULT_MASK, ...(s.mask || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(APP + '.settings', JSON.stringify(settings)); } catch { /* 無視 */ }
}

// ---------- 本体 ----------
const mosaic = new Mosaic();
const view = new View($('#view'), mosaic, () => settings.bgColor);
const stitcher = new Stitcher(mosaic, settings);
const store = new ProjectStore(mosaic);
const mini = $('#mini');
let busy = false;
let imageCropConfirmed = false;

const canLive = !!navigator.mediaDevices?.getDisplayMedia && !isMobile && !isNative;

let toastTimer = 0;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let coverage = 0;
function updateStats() {
  const n = mosaic.tiles.length;
  $('#empty').hidden = n > 0;
  mini.hidden = n === 0;
  coverage = n ? mosaic.coverage() : 0;
  $('#btnFill').hidden = !n || coverage > 0.995 || busy;
  if (!n) { $('#stats').textContent = '動画を取り込んで始めましょう'; return; }
  const bb = mosaic.bbox();
  const un = mosaic.tiles.filter((t) => !t.placed).length;
  let s = `${n}枚`;
  if (bb) s += ` ・ ${Math.round(bb.w).toLocaleString()}×${Math.round(bb.h).toLocaleString()}px ・ 埋まり ${Math.round(coverage * 100)}%`;
  if (un) s += ` ・ 未配置 ${un}`;
  $('#stats').textContent = s;
}
function setBusy(b) {
  if (b && !busy) keepAwake(true);        // 処理中は画面を消さない（消えると処理が止まるため）
  if (!b && busy) keepAwake(false);
  busy = b;
  $('#btnFill').hidden = b || !mosaic.tiles.length || coverage > 0.995;
}

let liveRect = null, liveLost = false;
function drawMini() {
  if (mini.hidden) return;
  drawOverview(mini, mosaic, { viewRect: view.visibleRect(), liveRect, lost: liveLost });
}
view.onViewChange = drawMini;

let warned = 0;
mosaic.warn = (msg) => { if (Date.now() - warned > 8000) { warned = Date.now(); toast(msg, 5000); } };
mosaic.onChange((kind) => {
  if (kind !== 'redraw') { updateStats(); store.schedule(); }
  view.draw();
});
mini.addEventListener('click', () => view.fit());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') store.flush().catch(() => {});
  else checkNativePending();
});

// ---------- 進捗ダイアログ ----------
const prog = {
  cancelled: false,
  open(title) {
    this.cancelled = false;
    $('#progTitle').textContent = title;
    $('#progBar').value = 0;
    $('#progText').textContent = '';
    if (!$('#dlgProgress').open) $('#dlgProgress').showModal();
  },
  set(v, text) {
    document.title = `(${Math.round(v * 100)}%) LargePic`;   // 別のタブにいても、タブの名前で進み具合が分かる
    $('#progBar').value = v;
    if (text != null) $('#progText').textContent = text;
    drawOverview($('#progMini'), mosaic, { liveRect, lost: liveLost });
  },
  close() { document.title = '画像つなぎ LargePic'; if ($('#dlgProgress').open) $('#dlgProgress').close(); },
};
$('#progCancel').onclick = () => { prog.cancelled = true; };
$('#dlgProgress').addEventListener('cancel', (e) => { e.preventDefault(); prog.cancelled = true; });

// 地図の回転・拡大率の変化を見つけて取り込みを止めたときの警告
function describeTransform(r) {
  const parts = [];
  if (Math.abs(r.angle) >= 3) parts.push(`地図が回転しています（約${Math.round(Math.abs(r.angle))}°）`);
  if (Math.abs(Math.log(r.scale)) >= Math.log(1.04)) {
    const z = r.scale < 1 ? 1 / r.scale : r.scale;
    parts.push(`拡大率が変わっています（約${z.toFixed(1)}倍に${r.scale < 1 ? '拡大' : '縮小'}）`);
  }
  return parts.length ? parts : ['地図の向きまたは拡大率が変わっています'];
}
function showTransformWarning(r, where, extra) {
  $('#warnTitle').textContent = '取り込みを停止しました';
  $('#warnBody').textContent = `${where}で、これまでの地図と合わなくなりました。${extra || ''}`;
  $('#warnList').innerHTML = describeTransform(r).map((t) => `<li><b>${t}</b></li>`).join('')
    + '<li>地図を<b>北上固定・回転オフ</b>にし、<b>拡大率は最初の撮影と同じ</b>にして、撮り直してください。</li>';
  $('#warnOk').onclick = () => $('#dlgWarn').close();
  const dlg = $('#dlgWarn');
  if (!dlg.open) dlg.showModal();
}

// 絵の食い違い（矛盾）を見つけて止めたとき。選んだ操作をして 'stop' か 'continue' を返す
function resolveConflict(r, where, batch) {
  importLog.events.push({ type: 'conflict', where, score: +r.score.toFixed(3) });
  return new Promise((resolve) => {
    const dlg = $('#dlgConflict');
    const mine = mosaic.batchTiles(batch).length;
    $('#cfBody').textContent = `${where}で、すでに取り込んだ部分と絵が食い違いました（重なる部分の一致度 ${Math.round(Math.max(0, r.score) * 100)}%）。`
      + 'このまま続けると、ずれが広がるおそれがあります。';
    $('#cfUndo3').disabled = mine < 1;
    $('#cfUndoAll').disabled = mine < 1;
    $('#cfUndoAll').textContent = `この取り込み分（${mine}枚）をすべて取り消して終了`;
    const done = (act) => {
      for (const id of ['cfUndo3', 'cfUndoAll', 'cfBackSave', 'cfKeep', 'cfIgnore']) $('#' + id).onclick = null;
      dlg.oncancel = null;
      dlg.close();
      resolve(act);
    };
    $('#cfUndo3').onclick = () => { const n = mosaic.removeLast(Math.min(3, mine)); toast(`直前の${n}枚を取り消しました`); done('stop'); };
    $('#cfUndoAll').onclick = () => { for (const t of mosaic.batchTiles(batch)) mosaic.remove(t); toast('この取り込み分を取り消しました'); done('stop'); };
    $('#cfBackSave').disabled = mine < 1;
    $('#cfBackSave').onclick = () => { mosaic.removeLast(1); pendingExport = true; done('stop'); };
    $('#cfKeep').onclick = () => done('stop');
    $('#cfIgnore').onclick = () => done('continue');
    dlg.oncancel = (e) => { e.preventDefault(); };
    dlg.showModal();
  });
}

// つながらなくなった（位置を見失い続けた）とき。選んだ操作をして 'stop' か 'continue' を返す
function resolveLost(where, batch, tracker = null) {
  importLog.events.push({ type: 'lost', where });
  return new Promise((resolve) => {
    const dlg = $('#dlgLost');
    const mine = mosaic.batchTiles(batch).length;
    const rot = tracker && tracker.tf && tracker.tf.last;   // 回転・拡大率の変化を疑う根拠が一度でも見つかっていた
    $('#lsBody').textContent = `${where}で、すでに取り込んだ部分と画像がつながらなくなったので止めました。`
      + (rot ? '地図が回転した、または拡大率が変わった可能性があります（撮影中は北上固定・拡大縮小なしにしてください）。' : '')
      + '無理に続けると、ずれた画像が増えるおそれがあります。';
    $('#lsBack').disabled = mine < 1;
    $('#lsUndo').disabled = mine < 1;
    $('#lsUndo').textContent = `この取り込み分（${mine}枚）を取り消して終了`;
    const done = (act) => {
      for (const id of ['lsBack', 'lsSave', 'lsContinue', 'lsUndo']) $('#' + id).onclick = null;
      dlg.oncancel = null;
      dlg.close();
      resolve(act);
    };
    $('#lsBack').onclick = () => { mosaic.removeLast(1); pendingExport = true; toast('一つ前に戻しました'); done('stop'); };
    $('#lsSave').onclick = () => { pendingExport = true; done('stop'); };
    $('#lsContinue').onclick = () => done('continue');
    $('#lsUndo').onclick = () => { for (const t of mosaic.batchTiles(batch)) mosaic.remove(t); toast('この取り込み分を取り消しました'); done('stop'); };
    dlg.oncancel = (e) => { e.preventDefault(); };
    dlg.showModal();
  });
}
// 取り込みを止めたあと、保存の画面を開く（止めるとき「保存へ」を選んだ場合）
let pendingExport = false;
function openExportIfPending() {
  if (!pendingExport) return;
  pendingExport = false;
  setTimeout(() => { if (!busy && mosaic.tiles.length) $('#btnExport').click(); }, 150);
}
const LOST_LIMIT = { key: 2, all: 6, live: 25 };   // 連続して見失ったら止める回数
function shouldStopLost(tracker, r, limit) {
  if (r.state !== 'lost') return false;
  if (tracker.lostIgnore > 0) { tracker.lostIgnore--; return false; }
  // 回転・拡大率の変化を疑っている間は、その判定（警告）を優先して少し待つ
  if (tracker.tf.hits > 0 && tracker.lostRun < limit + 2) return false;
  return tracker.everTracked && tracker.lostRun >= limit;
}

async function askCrop(kind, source, sw, sh, opts) {
  const r = await editCrop($('#dlgCrop'), source, sw, sh, settings.crops[kind], { ...opts, mask: settings.mask, detect: opts && opts.video ? (crop, cb) => detectStatic(opts.video, crop, { start: opts.start ?? 0, end: opts.video.duration, seek: seek0, ...cb }) : null });
  if (!r) return null;
  settings.crops[kind] = r.crop;
  settings.mask = r.mask;
  saveSettings();
  return r;
}

// ---------- スクリーンショット ----------
async function addImages(files) {
  if (!files.length || busy) return;
  setBusy(true);
  mosaic.newBatch();
  files = [...files].sort((a, b) => (a.lastModified - b.lastModified) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const counts = { placed: 0, unplaced: 0, first: 0 };
  try {
    let crop = settings.crops.image;
    const wasEmpty = !mosaic.tiles.length;
    for (let i = 0; i < files.length; i++) {
      const bmp = await decodeBitmap(files[i]);
      const w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
      if (i === 0 && (!imageCropConfirmed || wasEmpty)) {
        const r = await askCrop('image', bmp, w, h);
        if (!r) { bmp.close?.(); return; }
        crop = r.crop;
        imageCropConfirmed = true;
      }
      if (i === 0) prog.open('画像をつなげています…');
      prog.set(i / files.length, `${i + 1} / ${files.length} 枚目`);
      await nextFrame();
      const frame = grabFrame(bmp, w, h, crop, settings.mask);
      bmp.close?.();
      const r = await stitcher.addStill(frame, files[i]);
      counts[r]++;
      if (i === 0 && wasEmpty) view.fit();
      prog.set((i + 1) / files.length);
      if (prog.cancelled) break;
    }
  } catch (err) {
    console.error(err);
    toast('エラー: ' + err.message, 5000);
  } finally {
    prog.close();
    setBusy(false);
  }
  view.fit();
  const ok = counts.placed + counts.first;
  if (counts.unplaced) {
    toast(`${ok}枚をつなげました。${counts.unplaced}枚は位置が分からなかったので右側に置きました（✥調整でドラッグ）`, 6000);
  } else {
    toast(`${ok}枚をつなげました`);
  }
}

// ---------- 動画 ----------
function waitEvent(el, ev, ms = 8000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { el.removeEventListener(ev, f); rej(new Error(ev + ' timeout')); }, ms);
    const f = () => { clearTimeout(t); res(); };
    el.addEventListener(ev, f, { once: true });
  });
}

async function seek(video, t) {
  return perf.time('seek', () => seek0(video, t));
}
async function seek0(video, t) {
  if (Math.abs(video.currentTime - t) < 1e-3) return;
  const p = waitEvent(video, 'seeked');
  video.currentTime = t;
  await p;
}

let pendingWarn = null;
// 直前の動画取り込みの記録（診断情報としてコピーできる）
const importLog = { events: [] };
// file: File または Blob（ネイティブの録画ファイル）
async function addVideo(file, resume = null) {
  if (!file || busy) return;
  setBusy(true);
  const video = $('#video');
  const url = URL.createObjectURL(file);
  const wasEmpty = resume ? resume.wasEmpty : !mosaic.tiles.length;
  const batch = resume ? resume.batch : mosaic.newBatch();
  let jobActive = false;
  const t0Import = Date.now();
  importLog.events = [];
  perf.reset();
  Object.assign(importLog, { batch, file: file.name || '(blob)', size: file.size, startedAt: new Date().toISOString(), tilesBefore: mosaic.tiles.length });
  try {
    video.src = url;
    video.load();
    await waitEvent(video, 'loadeddata', 20000);
    try { await video.play(); video.pause(); } catch { /* 自動再生不可でもシークはできる */ }
    const dur = video.duration;
    if (!isFinite(dur) || !video.videoWidth) throw new Error('この動画は読み込めませんでした');
    await seek(video, Math.min(0.2, dur / 2));
    const sel = resume ? { crop: resume.crop, start: resume.start, end: resume.end, mask: resume.mask }
      : await askCrop('video', video, video.videoWidth, video.videoHeight, { video });
    if (!sel) return;
    const { crop, start, end } = sel;
    const mask = sel.mask || { ...DEFAULT_MASK };
    const tracker = new Tracker(stitcher);
    prog.open(wasEmpty ? '動画からつなげています…' : '追加の動画を取り込んでいます…');
    const step = settings.videoStep;
    let fitted = !wasEmpty || !!resume;
    let stopped = null;

    // 1) 事前解析：縮小した画像でスクロールの経路をたどり、取り込むコマ（キーフレーム）だけを選ぶ
    let keys = resume ? resume.keys : null;
    let fallbackWhy = '';
    try {
      if (resume) throw new Error('RESUME');   // 続きの取り込み：解析はやり直さない
      if (settings.fullScan) throw new Error('全コマ方式（設定）');
      prog.set(0, '動画を解析しています…');
      const plan = await perf.time('analysis', () => analyzeVideo(video, crop, {
        mask, start, end, step: Math.min(0.12, step), threshold: settings.threshold,
        onProgress: (p) => prog.set(p * 0.4, `動画を解析しています… ${Math.round(p * 100)}%`),
        isCancelled: () => prog.cancelled,
      }));
      Object.assign(importLog, { analysis: { lastT: plan.samples.length ? +plan.samples[plan.samples.length - 1].t.toFixed(2) : null, duration: +video.duration.toFixed(2), mode: plan.mode, samples: plan.samples.length, brokenFraction: +plan.brokenFraction.toFixed(3), segments: new Set(plan.samples.map((q) => q.seg)).size } });
      if (!prog.cancelled && plan.samples.length >= 3 && plan.brokenFraction < 0.5) {
        // マスクがあるときは、隠れた所が次のコマで見えるよう、コマの間隔をせまくする
        keys = selectKeyframes(plan, { minOverlap: mask.on ? 0.6 : 0.4 });
        importLog.keyframes = keys.length;
        importLog.lastKeyT = +keys[keys.length - 1].t.toFixed(2);
        console.log(`解析(${plan.mode}): ${plan.samples.length}コマ → キーフレーム ${keys.length} 途切れ${Math.round(plan.brokenFraction * 100)}% 区間${new Set(plan.samples.map((q) => q.seg)).size}`);
        if (keys.length < 2) keys = null;
      }
    } catch (err) {
      if (!resume) {
        console.warn('解析に失敗。全コマ方式に切り替えます', err);
        fallbackWhy = settings.fullScan ? '' : '（解析に失敗したため全コマ方式）';
        importLog.analysisError = String(err && err.message || err);
      }
    }

    if (keys) {
      // 途中経過を端末に残す：ブラウザが裏でページを止めても、戻ったときに続きから取り込める
      if (resume) jobActive = true;
      else jobActive = await jobs.start({ keys, crop, mask, start, end, batch, wasEmpty, name: file.name || '動画' }, file);
      // 2) 選んだコマだけを高解像度で取り込む（解析で分かった移動量を位置合わせのヒントに使う）
      const reader = makeKeyReader(video, () => grabFrame(video, video.videoWidth, video.videoHeight, crop, mask), seek0);
      const i0 = resume ? Math.min(resume.next, keys.length - 1) : 0;
      if (resume) keys[i0] = { ...keys[i0], newSeg: true };   // 続きの最初は、取り込み済みの場所から探し直す
      for (let i = i0; i < keys.length; i++) {
        if (prog.cancelled) break;
        const k = keys[i], pk = i > i0 ? keys[i - 1] : null;
        const frame = await perf.time('seek', () => reader.get(k.t));   // 再生しながら、そのコマが出た瞬間に取り込む
        const hint = pk && !k.newSeg ? { dx: k.x - pk.x, dy: k.y - pk.y } : undefined;
        const r = await tracker.process(frame, { hint, kpos: { x: k.x, y: k.y }, vt: k.t, newSeg: k.newSeg, key: true, final: i === keys.length - 1 });
        if (r.state === 'transform') { stopped = { r, t: k.t }; break; }
        if (shouldStopLost(tracker, r, LOST_LIMIT.key)) {
          const tr = tracker.quickTransformCheck();
          if (tr) { stopped = { r: tr, t: k.t }; break; }
          const act = await resolveLost(`動画の ${(k.t - start).toFixed(1)} 秒付近`, batch, tracker);
          if (act === 'continue') { tracker.lostRun = 0; tracker.lostIgnore = 6; } else { stopped = { conflict: true }; break; }
        }
        if (r.state === 'conflict') {
          const act = await resolveConflict(r, `動画の ${(k.t - start).toFixed(1)} 秒付近`, batch);
          if (act === 'continue') { tracker.ignoreConflicts = 4; } else { stopped = { conflict: true }; break; }
        }
        if (r.state === 'added' && !fitted) { view.fit(); fitted = true; }
        liveRect = r.rect; liveLost = r.state === 'lost';
        const msg = r.state === 'waiting' ? ' ・ スクロールの始まりを探しています…'
          : liveLost ? ' ・ 位置を探しています（取り込み済みの場所が映るまで待機）' : '';
        prog.set(0.4 + 0.6 * (i + 1) / keys.length,
          `取り込み ${i + 1} / ${keys.length} コマ ・ 追加 ${tracker.stats.added}枚${msg}`);
        if (jobActive) jobs.progress(Math.max(0, i - 1));   // 直前の1コマは、保存が間に合っていないかもしれないのでやり直す
        await nextFrame();
      }
    } else {
      // 解析できなかったときは、一定間隔で全コマを調べる（従来の方式）
      const times = [];
      for (let t = start; t < end - step / 2; t += step) times.push(t);
      times.push(Math.max(start, end - 0.05));
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        if (prog.cancelled) break;
        await seek(video, t);
        const frame = grabFrame(video, video.videoWidth, video.videoHeight, crop, mask);
        const r = await tracker.process(frame, { final: i === times.length - 1 });
        if (r.state === 'transform') { stopped = { r, t }; break; }
        if (shouldStopLost(tracker, r, LOST_LIMIT.all)) {
          const tr = tracker.quickTransformCheck();
          if (tr) { stopped = { r: tr, t }; break; }
          const act = await resolveLost(`動画の ${(t - start).toFixed(1)} 秒付近`, batch, tracker);
          if (act === 'continue') { tracker.lostRun = 0; tracker.lostIgnore = 12; } else { stopped = { conflict: true }; break; }
        }
        if (r.state === 'conflict') {
          const act = await resolveConflict(r, `動画の ${(t - start).toFixed(1)} 秒付近`, batch);
          if (act === 'continue') { tracker.ignoreConflicts = 4; } else { stopped = { conflict: true }; break; }
        }
        if (r.state === 'added' && !fitted) { view.fit(); fitted = true; }
        liveRect = r.rect; liveLost = r.state === 'lost';
        const msg = r.state === 'waiting' ? ' ・ スクロールの始まりを探しています…'
          : liveLost ? ' ・ 位置を探しています（取り込み済みの場所が映るまで待機）' : '';
        prog.set((t - start) / Math.max(0.01, end - start),
          `${(t - start).toFixed(1)} / ${(end - start).toFixed(1)} 秒 ・ 取り込み ${tracker.stats.added}枚${msg}${fallbackWhy}`);
        await nextFrame();
      }
    }
    liveRect = null;
    view.fit();
    const { added, lost } = tracker.stats;
    console.log('解析結果 取り込み統計', JSON.stringify(tracker.stats));
    importLog.perf = perf.report();
    Object.assign(importLog, { method: keys ? 'keyframes' : 'allframes', stats: tracker.stats, ms: Date.now() - t0Import, stopped: stopped ? (stopped.conflict ? 'conflict' : 'transform') : null });
    if (stopped?.conflict) {
      if (!pendingExport) toast('取り込みを止めました。［↶ 戻す］でさらに取り消せます', 6000);
    } else if (stopped) {
      pendingWarn = [stopped.r, `動画の ${(stopped.t - start).toFixed(1)} 秒付近`,
        added ? `ここまでの${added}枚は取り込み済みです。` : ''];
    } else if (!wasEmpty && added === 0) {
      toast('取り込み済みの場所が見つからず、追加できませんでした。撮影の最初に取り込み済みの場所を映してください', 7000);
    } else {
      const weak = tracker.stats.weak || 0;
      toast(`動画から${added}枚を取り込みました` + (lost > 3 ? `（${lost}コマは位置が分からずスキップ）` : '')
        + (weak ? `。${weak}枚は位置に自信がありません（海など模様の少ない所）。［✥調整］のオレンジの枠を確認してください` : ''), weak ? 8000 : 5000);
    }
  } catch (err) {
    console.error(err);
    toast('エラー: ' + err.message, 5000);
  } finally {
    prog.close();
    jobs.clear();
    notifyDone('動画の取り込みが終わりました');
    if (pendingWarn) { showTransformWarning(...pendingWarn); pendingWarn = null; }
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    liveRect = null;
    setBusy(false);
    openExportIfPending();
  }
}

// ---------- 撮影モード ----------
const STEPS = {
  'native-android': [
    '下の［録画を開始］→ 確認画面で「開始」',
    'ホームに戻って地図アプリを開き、ルールを守ってスクロール',
    '終わったら通知の［停止］か、このアプリに戻って［停止して取り込む］',
  ],
  'native-ios': [
    '下の［録画を開始］→「ブロードキャストを開始」',
    '地図アプリに切り替えて、ルールを守ってスクロール',
    '画面上部の赤い表示をタップして停止 → このアプリに戻ると取り込みます',
  ],
  ios: [
    'コントロールセンターを開き「画面収録」◉ をタップ（3秒後に開始）',
    '地図アプリでルールを守ってスクロール',
    '画面上部の赤い表示をタップして停止（写真アプリに保存されます）',
    'このアプリに戻って［録画した動画を選ぶ］',
  ],
  android: [
    'クイック設定（画面上から2回スワイプ）の「スクリーンレコード」で録画開始',
    '地図アプリでルールを守ってスクロール',
    '通知から録画を停止',
    'このアプリに戻って［録画した動画を選ぶ］',
  ],
  desktop: [
    '［ライブ取り込み］で地図のタブやウィンドウを選ぶと、スクロールした範囲がこの画面にリアルタイムで表示されます',
    'または、画面録画した動画ファイルを［録画した動画を選ぶ］で読み込み',
  ],
};

function openCapture(fill = false) {
  if (busy) return toast('処理中です');
  const key = isNative ? 'native-' + nativePlatform : webPlatform;
  $('#capTitle').textContent = fill ? '不足部分を動画で追加' : '動画を取り込む';
  $('#capFill').hidden = !fill;
  $('#capSteps').innerHTML = (STEPS[key] || STEPS.desktop).map((s) => `<li>${s}</li>`).join('');
  $('#capStart').hidden = !(isNative && ScreenRecorder);
  $('#capLive').hidden = !canLive;
  $('#dlgCapture').showModal();
}
$('#btnFill').onclick = () => openCapture(true);
$('#capPick').onclick = () => { $('#dlgCapture').close(); $('#fileVideo').click(); };
$('#capLive').onclick = () => { $('#dlgCapture').close(); startLive(); };
$('#capStart').onclick = startNativeRecording;

// ---- ネイティブ版の画面収録 ----
async function startNativeRecording() {
  $('#dlgCapture').close();
  try {
    await store.flush();
    await ScreenRecorder.start();
    if (nativePlatform === 'android') {
      $('#recbar').hidden = false;
      toast('録画を開始しました。ホームに戻って地図アプリで撮影してください', 5000);
    } else {
      toast('「ブロードキャストを開始」を押してから地図アプリへ。終わったらこのアプリに戻ってください', 7000);
    }
  } catch (err) {
    toast('録画を開始できませんでした: ' + (err.message || err), 5000);
  }
}
$('#btnRecStop').onclick = async () => {
  $('#recbar').hidden = true;
  try {
    const r = await ScreenRecorder.stop();
    if (r?.path) await importNative(r.path);
  } catch (err) {
    toast('録画の停止に失敗しました: ' + (err.message || err), 5000);
  }
};
async function importNative(path) {
  if (busy) return;
  const blob = await nativeFileToBlob(path);
  await ScreenRecorder.clearPending?.();
  await addVideo(blob);
}
let checking = false;
async function checkNativePending() {
  if (!isNative || !ScreenRecorder || checking || busy) return;
  checking = true;
  try {
    const r = await ScreenRecorder.getPending();
    if (r?.path) { $('#recbar').hidden = true; await importNative(r.path); }
    else if (r?.recording && nativePlatform === 'android') $('#recbar').hidden = false;
  } catch (err) {
    console.warn(err);
  } finally {
    checking = false;
  }
}
if (isNative && ScreenRecorder) {
  ScreenRecorder.addListener?.('recordingStopped', () => {
    $('#recbar').hidden = true;
    if (document.visibilityState === 'visible') checkNativePending();
  });
}

// ---------- ライブ（PC の画面共有） ----------
const live = { stream: null, running: false, paused: false, tracker: null, crop: null, pip: null, busyFrame: null };

async function startLive() {
  if (busy) return;
  if (!canLive) { toast('この端末ではライブ取り込みが使えません。画面収録した動画をお使いください', 5000); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch {
    return;
  }
  const video = $('#video');
  video.srcObject = stream;
  try { await video.play(); } catch { /* */ }
  for (let i = 0; i < 50 && !video.videoWidth; i++) await new Promise((r) => setTimeout(r, 100));
  const sel = await askCrop('live', video, video.videoWidth, video.videoHeight);
  if (!sel) { stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; return; }
  setBusy(true);
  live.batch = mosaic.newBatch();
  Object.assign(live, { stream, running: true, paused: false, tracker: new Tracker(stitcher), crop: sel.crop, mask: settings.mask });
  stream.getVideoTracks()[0].addEventListener('ended', stopLive);
  $('#livebar').hidden = false;
  $('#btnPip').hidden = !('documentPictureInPicture' in window);
  $('#btnLivePause').textContent = '一時停止';
  liveLoop();
}

async function liveLoop() {
  const video = $('#video');
  let fitted = !!mosaic.tiles.length;
  while (live.running) {
    const t0 = performance.now();
    if (!live.paused && video.videoWidth) {
      try {
        const frame = grabFrame(video, video.videoWidth, video.videoHeight, live.crop, live.mask);
        live.busyFrame = live.tracker.process(frame);
        const r = await live.busyFrame;
        if (!live.running) break;
        if (r.state === 'transform') {
          live.paused = true;
          $('#btnLivePause').textContent = '再開';
          setLiveState('lost', '停止中：地図が回転 / 拡大率が変わりました');
          showTransformWarning(r, 'ライブ取り込み中', 'ここで取り込みを一時停止しました（［再開］で続けられます）。');
          continue;
        }
        if (r.state === 'conflict') {
          live.paused = true;
          $('#btnLivePause').textContent = '再開';
          setLiveState('lost', '停止中：絵が食い違いました');
          const act = await resolveConflict(r, 'ライブ取り込み中', live.batch);
          if (act === 'continue') { live.tracker.ignoreConflicts = 4; live.paused = false; $('#btnLivePause').textContent = '一時停止'; live.tracker.lost = true; }
          else { await stopLive(); openExportIfPending(); }
          continue;
        }
        if (shouldStopLost(live.tracker, r, LOST_LIMIT.live)) {
          live.paused = true;
          $('#btnLivePause').textContent = '再開';
          setLiveState('lost', '停止中：画像がつながらなくなりました');
          const act = await resolveLost('ライブ取り込み中', live.batch, live.tracker);
          if (act === 'continue') { live.tracker.lostRun = 0; live.tracker.lostIgnore = 30; live.paused = false; $('#btnLivePause').textContent = '一時停止'; live.tracker.lost = true; }
          else { await stopLive(); openExportIfPending(); }
          continue;
        }
        liveRect = r.rect; liveLost = r.state === 'lost';
        view.liveRect = liveRect; view.lost = liveLost;
        if (!fitted && r.state === 'added') { view.fit(); fitted = true; }
        if (liveRect) view.follow(liveRect);
        view.draw();
        if (r.state === 'waiting') setLiveState('ok', 'スクロールを始めてください');
        else setLiveState(liveLost ? 'lost' : 'ok', liveLost ? '見失いました。取り込み済みの場所へ戻してください' : `取り込み中（${mosaic.tiles.length}枚）`);
        drawPip();
      } catch (err) {
        console.error(err);
      }
    }
    const dt = performance.now() - t0;
    await sleep(Math.max(30, 120 - dt));   // 別のタブを見ていても間引かれない待ち方
  }
}

function setLiveState(kind, text) {
  $('#liveState').className = 'live-state ' + (kind === 'ok' ? '' : kind);
  $('#liveText').textContent = text;
  if (live.pip) {
    const t = live.pip.document.getElementById('t');
    t.textContent = text;
    t.style.color = kind === 'lost' ? '#ffb020' : '#e9edf2';
  }
}

async function stopLive() {
  if (!live.running) return;
  live.running = false;
  // 最後に映っていた範囲も取り込む
  const video = $('#video');
  if (!live.paused && video.videoWidth && live.stream?.active) {
    try {
      await live.busyFrame;
      await live.tracker.process(grabFrame(video, video.videoWidth, video.videoHeight, live.crop, live.mask), { final: true });
    } catch { /* */ }
  }
  live.stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  live.pip?.close();
  live.pip = null;
  $('#livebar').hidden = true;
  liveRect = null; view.liveRect = null;
  setBusy(false);
  view.fit();
  toast(`ライブ取り込みを終了しました（${mosaic.tiles.length}枚）`);
}

async function openPip() {
  if (!('documentPictureInPicture' in window) || live.pip) return;
  const w = await window.documentPictureInPicture.requestWindow({ width: 300, height: 380 });
  w.document.body.style.cssText = 'margin:0;background:#111418;color:#e9edf2;font:13px system-ui,sans-serif;display:flex;flex-direction:column;height:100vh';
  w.document.body.innerHTML = '<div id="t" style="padding:6px 8px">取り込み中</div><canvas id="c" style="flex:1;width:100%;min-height:0"></canvas>';
  live.pip = w;
  w.addEventListener('pagehide', () => { live.pip = null; });
  drawPip();
}

function drawPip() {
  if (!live.pip) return;
  drawOverview(live.pip.document.getElementById('c'), mosaic, { liveRect, lost: liveLost });
}

$('#btnLiveStop').onclick = stopLive;
$('#btnLivePause').onclick = () => {
  live.paused = !live.paused;
  $('#btnLivePause').textContent = live.paused ? '再開' : '一時停止';
  if (live.paused) setLiveState('paused', '一時停止中');
  else { live.tracker.lost = true; live.tracker.clearTransform(); } // 再開時は位置を探し直す
};
$('#btnPip').onclick = openPip;

// ---------- 調整モード ----------
function setAdjust(on) {
  view.mode = on ? 'adjust' : 'pan';
  if (!on) view.selected = null;
  $('#adjustbar').hidden = !on;
  $('#btnAdjust').classList.toggle('on', on);
  if (on && !view.selected) view.selected = mosaic.tiles.find((t) => !t.placed) || null;
  view.draw();
}
$('#btnAdjust').onclick = () => setAdjust(view.mode !== 'adjust');
$('#btnAdjustDone').onclick = () => setAdjust(false);
view.onTap = (w) => {
  if (view.mode !== 'adjust') return;
  view.selected = mosaic.hitTest(w.x, w.y);
  view.draw();
};
view.onTileMoved = async (tile) => {
  if (busy) return;
  setBusy(true);
  try {
    const ok = await stitcher.snap(tile);
    if (ok) toast('ピタッと合わせました');
    else { tile.placed = true; mosaic.changed(); toast('合う場所が見つからないので、その位置に置きました'); }
  } finally { setBusy(false); }
};
$('#btnSnap').onclick = async () => {
  const t = view.selected;
  if (!t || busy) return toast('タイルを選んでください');
  setBusy(true);
  try { toast((await stitcher.snap(t)) ? 'ピタッと合わせました' : '近くに合う場所が見つかりませんでした'); }
  finally { setBusy(false); }
};
$('#btnAuto').onclick = async () => {
  const t = view.selected;
  if (!t || busy) return toast('タイルを選んでください');
  setBusy(true);
  toast('探しています…', 10000);
  try { toast((await stitcher.autoPlace(t)) ? '合う場所に移動しました' : '合う場所が見つかりませんでした'); }
  finally { setBusy(false); }
};
$('#btnFront').onclick = () => { if (view.selected) mosaic.bringToFront(view.selected); };
$('#btnDelete').onclick = () => {
  if (!view.selected) return toast('タイルを選んでください');
  mosaic.remove(view.selected);
  view.selected = null;
};

// ---------- その他のボタン ----------
document.querySelectorAll('[data-action]').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.preventDefault();
    const a = b.dataset.action;
    if (a === 'help') { b.closest('dialog')?.close(); $('#dlgHelp').showModal(); return; }
    if (busy) return toast('処理中です');
    if (a === 'capture') openCapture(mosaic.tiles.length > 0 && coverage < 0.995);
    if (a === 'images') $('#fileImages').click();
    if (a === 'viewer') openGallery();
  });
});
$('#fileImages').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; addImages(f); };
$('#fileVideo').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; addVideo(f); };
$('#btnFit').onclick = () => view.fit();
$('#btnUndo').onclick = () => {
  if (busy || !mosaic.tiles.length) return;
  const last = mosaic.tiles.reduce((x, y) => (y.id > x.id ? y : x));
  const n = mosaic.batchTiles(last.batch).length;
  $('#undoInfo').textContent = `全部で${mosaic.tiles.length}枚。直近の取り込みは${n}枚です。`;
  $('#undoBatchN').textContent = n;
  $('#undo5').disabled = mosaic.tiles.length < 2;
  $('#undoBatch').disabled = n < 1;
  $('#dlgUndo').showModal();
};
const undoDone = (msg) => { view.selected = null; $('#dlgUndo').close(); toast(msg); };
$('#undo1').onclick = () => { const n = mosaic.removeLast(1); undoDone(`${n}枚を取り消しました`); };
$('#undo5').onclick = () => { const n = mosaic.removeLast(5); undoDone(`${n}枚を取り消しました`); };
$('#undoBatch').onclick = () => {
  const last = mosaic.tiles.reduce((x, y) => (y.id > x.id ? y : x));
  const list = mosaic.batchTiles(last.batch);
  for (const t of list) mosaic.remove(t);
  undoDone(`直近の取り込み（${list.length}枚）を取り消しました`);
};
$('#btnHelp').onclick = () => $('#dlgHelp').showModal();
document.querySelectorAll('dialog [data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });

// 設定
function bindRange(id, out, key, fmt) {
  const el = $(id), o = $(out);
  el.value = settings[key];
  o.textContent = fmt(settings[key]);
  el.oninput = () => { settings[key] = parseFloat(el.value); o.textContent = fmt(settings[key]); saveSettings(); };
}
$('#setBgColor').value = settings.bgColor;
$('#setBgColor').onchange = () => { settings.bgColor = $('#setBgColor').value; saveSettings(); view.redraw(); };
bindRange('#setThr', '#outThr', 'threshold', (v) => v.toFixed(2));
bindRange('#setStep', '#outStep', 'videoStep', (v) => v.toFixed(2) + ' 秒');
bindRange('#setAdd', '#outAdd', 'addUncovered', (v) => Math.round(v * 100) + '%');
$('#btnSettings').onclick = () => $('#dlgSettings').showModal();
$('#btnPickVideo').onclick = () => { $('#dlgSettings').close(); $('#fileVideo').click(); };
$('#btnClear').onclick = async () => {
  if (!confirm('すべての画像を消去しますか？')) return;
  mosaic.clear();
  await store.clear();
  view.selected = null;
  view.fit();
  $('#dlgSettings').close();
};
$('#btnCropEdit').onclick = async () => {
  $('#dlgSettings').close();
  const t = mosaic.tiles[0];
  let src = null, w = 0, h = 0;
  if (t) {
    src = await decodeBitmap(t.src);
    w = src.naturalWidth || src.width; h = src.naturalHeight || src.height;
  } else {
    src = document.createElement('canvas');
    w = src.width = 390; h = src.height = 844;
    const ctx = src.getContext('2d');
    ctx.fillStyle = '#556'; ctx.fillRect(0, 0, w, h);
  }
  const r = await askCrop('image', src, w, h);
  if (r) { settings.crops.video = r.crop; saveSettings(); }
  imageCropConfirmed = true;
  src.close?.();
  toast('次に追加する画像・動画から適用されます');
};

// ---------- 書き出し ----------
function exportLimits() {
  const maxSide = isIOS ? 16384 : (isMobile ? 16384 : 32767);
  const maxArea = isIOS ? 16777216 : (isMobile ? 100e6 : 250e6);
  return { maxSide, maxArea };
}
const trim = new TrimEditor($('#trimCanvas'), mosaic, drawOverview);
const exp = { shape: 'rect', fit: 'outer' };
const FIT_HINT = {
  outer: '取り込んだ全体が入る大きさ。すき間は下の色で埋まります。',
  inner: 'すき間が入らない、いちばん大きな形。',
  free: 'プレビューの枠をドラッグして移動、角の丸をドラッグで大きさを変更。',
};

function segSet(id, v) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}
function updateTrim(recompute = true) {
  if (recompute && exp.fit !== 'free') {
    trim.rect = computeTrim(mosaic, exp.shape, exp.fit) || computeTrim(mosaic, exp.shape, 'outer');
  }
  if (exp.fit === 'free' && exp.shape === 'circle' && trim.rect && trim.rect.w !== trim.rect.h) {
    const k = Math.min(trim.rect.w, trim.rect.h);
    trim.rect = { x: trim.rect.x + (trim.rect.w - k) / 2, y: trim.rect.y + (trim.rect.h - k) / 2, w: k, h: k };
  }
  trim.shape = exp.shape;
  trim.editable = exp.fit === 'free';
  $('#fitHint').textContent = FIT_HINT[exp.fit];
  trim.draw();
  updateScaleOptions();
}
trim.onChange = () => updateScaleOptions();

const isTiledExport = () => $('#expType').value === 'tiles';
// 1枚の画像として作れる最大の倍率（端末のキャンバス上限）。分割保存なら制限なし
function singleMaxScale(r) {
  const { maxSide, maxArea } = exportLimits();
  return Math.min(1, maxSide / r.w, maxSide / r.h, Math.sqrt(maxArea / (r.w * r.h)));
}
function updateScaleOptions() {
  const r = trim.rect;
  if (!r) return;
  const tiled = isTiledExport();
  const maxScale = tiled ? 1 : singleMaxScale(r);
  const sel = $('#expScale');
  const prev = parseFloat(sel.value) || 1;
  sel.innerHTML = '';
  const opts = [1, 0.75, 0.5, 0.35, 0.25].filter((s) => s <= maxScale + 1e-9);
  if (!opts.length || opts[0] < maxScale - 0.01) opts.unshift(Math.floor(maxScale * 100) / 100);
  for (const s of opts) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = `${Math.round(s * 100)}%（${Math.round(r.w * s).toLocaleString()}×${Math.round(r.h * s).toLocaleString()}px）`;
    sel.appendChild(o);
  }
  if (opts.includes(prev)) sel.value = prev;
  const un = mosaic.tiles.filter((t) => !t.placed).length;
  $('#expWarn').textContent = [
    tiled ? '分割保存は、このアプリの［🔍 閲覧］で継ぎ目なく見られます。ZIPを展開すると、タイル画像（PNG）も取り出せます。'
      : (maxScale < 1 ? `1枚の画像は、この端末では最大 ${Math.round(maxScale * 100)}% までです。元の画質で残すなら「分割保存」を選んでください。` : ''),
    un ? `未配置の${un}枚は含まれません。` : '',
  ].join(' ');
}
$('#expType').onchange = () => updateScaleOptions();

document.querySelectorAll('#segShape button').forEach((b) => {
  b.onclick = () => { exp.shape = b.dataset.v; segSet('segShape', exp.shape); updateTrim(exp.fit !== 'free'); };
});
document.querySelectorAll('#segFit button').forEach((b) => {
  b.onclick = () => { exp.fit = b.dataset.v; segSet('segFit', exp.fit); updateTrim(); };
});

let lastUrl = null, lastFile = null;
$('#btnExport').onclick = () => {
  const bb = mosaic.bbox();
  if (!bb) return toast('まだ画像がありません');
  $('#expInfo').textContent = `全体 ${Math.round(bb.w).toLocaleString()}×${Math.round(bb.h).toLocaleString()}px ・ ${mosaic.placed().length}枚 ・ 埋まり ${Math.round(mosaic.coverage() * 100)}%`;
  $('#expResult').hidden = true;
  $('#expGo').disabled = false;
  $('#dlgExport').showModal();
  updateTrim();
  // 元の大きさでは1枚にできない大きさなら、分割保存を初期選択にする
  if (trim.rect && singleMaxScale(trim.rect) < 1 && !isTiledExport()) { $('#expType').value = 'tiles'; updateScaleOptions(); }
};
$('#expGo').onclick = async () => {
  if (busy || !trim.rect) return;
  setBusy(true);
  $('#expGo').disabled = true;
  const scale = parseFloat($('#expScale').value);
  const tiled = isTiledExport();
  const type = tiled ? 'application/zip' : $('#expType').value;
  let bg = $('#expBg').value;
  if (!tiled && bg === 'transparent' && type !== 'image/png') bg = '#ffffff';
  const circle = exp.shape === 'circle';
  $('#expDone').textContent = '作成中…';
  $('#expResult').hidden = false;
  $('#expDownload').hidden = true;
  $('#expShare').hidden = true;
  $('#expLib').hidden = true;
  try {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
    let blob;
    if (tiled) {
      ({ blob } = await exportTiles(mosaic, {
        region: trim.rect, scale, background: bg, circle, name: `LargePic-${stamp}`,
        onProgress: (p) => { $('#expDone').textContent = `分割して保存用データを作成中… ${Math.round(p * 100)}%`; },
      }));
    } else {
      blob = await mosaic.exportBlob({
        scale, background: bg, type, quality: 0.92, region: trim.rect, circle,
        outside: circle && type !== 'image/png' ? bg : null,
        onProgress: (p) => { $('#expDone').textContent = `作成中… ${Math.round(p * 100)}%`; },
      });
    }
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    const ext = tiled ? 'zip' : (type === 'image/png' ? 'png' : 'jpg');
    const name = `LargePic-${stamp}${tiled ? '-tiles' : ''}.${ext}`;
    lastFile = new File([blob], name, { type });
    const r0 = trim.rect;
    saveToLibrary(lastFile, tiled ? 'tiles' : 'image', Math.round(r0.w * scale), Math.round(r0.h * scale));
    const a = $('#expDownload');
    a.href = lastUrl;
    a.download = name;
    a.hidden = false;
    $('#expShare').hidden = !(navigator.canShare && navigator.canShare({ files: [lastFile] }));
    $('#expDone').textContent = `できました：${name}（${(blob.size / 1048576).toFixed(1)} MB）`;
  } catch (err) {
    console.error(err);
    $('#expDone').textContent = 'エラー: ' + err.message + (isTiledExport() ? '' : '　小さいサイズを選ぶか、分割保存を選んで再度お試しください。');
  } finally {
    $('#expGo').disabled = false;
    setBusy(false);
  }
};
$('#expShare').onclick = async () => {
  if (!lastFile) return;
  try { await navigator.share({ files: [lastFile] }); } catch { /* キャンセル */ }
};

// ---------- ビューア（保存した大きな画像を地図のように見る）----------
const viewer = new ImageViewer($('#viewerCanvas'), (st) => {
  const pct = Math.round(st.sEff * 100);
  $('#viewerInfo').innerHTML = `${st.w.toLocaleString()} × ${st.h.toLocaleString()} px<br>${pct}%`;
});
let hintTimer = 0;
async function openViewer(blob) {
  $('#viewer').hidden = false;
  $('#viewerLoading').hidden = false;
  $('#viewerHint').classList.remove('off');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => $('#viewerHint').classList.add('off'), 4000);
  try {
    await viewer.load(blob);
  } catch (err) {
    console.error(err);
    toast('画像を開けませんでした（形式またはサイズが大きすぎる可能性があります）', 5000);
    closeViewer();
    return;
  } finally {
    $('#viewerLoading').hidden = true;
  }
}
function closeViewer() {
  viewer.dispose();
  $('#viewer').hidden = true;
}
// 書き出した画像を、この端末のライブラリにも入れる（［閲覧］の一覧で優先して開ける）
async function saveToLibrary(file, kind, width, height) {
  try {
    await library.add({ name: file.name, blob: file, kind, width, height });
    $('#expLib').hidden = false;
  } catch (e) {
    console.warn('ライブラリに保存できませんでした', e);
    $('#expLib').hidden = true;
    toast('端末の保存領域に入りませんでした。「ダウンロード」で保存してください', 6000);
  }
}
// ---- 保存した画像の一覧（閲覧の入口）----
let viewerFromGallery = false;
const fmtSize = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
const thumbUrls = [];
async function openGallery() {
  $('#gallery').hidden = false;
  const listEl = $('#galleryList');
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  listEl.innerHTML = '';
  let items = [];
  try { items = await library.list(); } catch (e) { console.warn(e); }
  $('#galleryEmpty').hidden = items.length > 0;
  for (const it of items) {
    const card = document.createElement('div');
    card.className = 'gcard';
    const url = it.thumb ? URL.createObjectURL(it.thumb) : '';
    if (url) thumbUrls.push(url);
    const d = new Date(it.createdAt);
    const p2 = (n) => String(n).padStart(2, '0');
    card.innerHTML = `<button class="gthumb" aria-label="開く" style="${url ? `background-image:url(${url})` : ''}"></button>
      <div class="ginfo"><b></b>${it.kind === 'tiles' ? '<span class="gbadge">分割</span>' : ''}${it.width.toLocaleString()}×${it.height.toLocaleString()}px<br>${fmtSize(it.size)} ・ ${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}</div>
      <div class="gbtns"><button data-act="dl">保存</button><button data-act="del" class="danger">削除</button></div>`;
    card.querySelector('b').textContent = it.name;
    card.querySelector('.gthumb').onclick = async () => {
      const blob = await library.blob(it.id);
      if (!blob) return toast('ファイルが見つかりません', 3000);
      viewerFromGallery = true;
      $('#gallery').hidden = true;
      openViewer(new File([blob], it.name, { type: blob.type }));
    };
    card.querySelector('[data-act=dl]').onclick = async () => {
      const blob = await library.blob(it.id);
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = it.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    };
    card.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`「${it.name}」を削除しますか？（この端末のライブラリから消えます）`)) return;
      await library.remove(it.id);
      openGallery();
    };
    listEl.appendChild(card);
  }
  const u = await library.usage();
  $('#galleryUsage').textContent = u ? `この端末の保存領域：${fmtSize(u.used)} 使用中（上限の目安 ${fmtSize(u.quota)}）` : '';
}
function closeGallery() {
  $('#gallery').hidden = true;
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
}
$('#btnViewer').onclick = () => openGallery();
$('#galleryClose').onclick = closeGallery;
$('#galleryOpenFile').onclick = () => $('#fileView').click();
$('#fileView').onchange = (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  viewerFromGallery = !$('#gallery').hidden;   // 一覧から開いたなら、閉じたときに一覧へ戻る
  closeGallery();
  openViewer(f);
};
$('#viewerClose').onclick = () => { const back = viewerFromGallery; closeViewer(); if (back) openGallery(); };
$('#viewerOpen').onclick = () => { closeViewer(); openGallery(); };
$('#viewerZoomIn').onclick = () => viewer.zoomBy(1.6);
$('#viewerZoomOut').onclick = () => viewer.zoomBy(1 / 1.6);
$('#viewerFit').onclick = () => viewer.fit();
$('#viewer100').onclick = () => viewer.actualSize();
$('#expView').onclick = () => { if (lastFile) { $('#dlgExport').close(); openViewer(lastFile); } };
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#viewer').hidden) $('#viewerClose').click();
  else if (!$('#gallery').hidden) closeGallery();
});

// ---------- 完了の通知（別のタブ・アプリを見ているとき）----------
function notifyDone(msg) {
  try {
    if (settings.notify && document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('LargePic', { body: msg });
  } catch { /* 通知に対応していない端末もある */ }
}
$('#setNotify').checked = !!settings.notify;
$('#setNotify').onchange = async () => {
  const on = $('#setNotify').checked;
  if (on && 'Notification' in window && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') { $('#setNotify').checked = false; toast('通知が許可されませんでした', 4000); settings.notify = false; saveSettings(); return; }
  } else if (on && !('Notification' in window)) {
    $('#setNotify').checked = false; toast('この端末のブラウザは通知に対応していません', 4000); return;
  }
  settings.notify = on; saveSettings();
};

// ---------- 診断情報 ----------
$('#appVersion').textContent = APP_VERSION;
function diagnostics() {
  return {
    app: 'LargePic', version: APP_VERSION, time: new Date().toISOString(),
    ua: navigator.userAgent, dpr: window.devicePixelRatio,
    settings: { threshold: settings.threshold, videoStep: settings.videoStep, addUncovered: settings.addUncovered, conflictBelow: settings.conflictBelow, fullScan: !!settings.fullScan, crop: settings.crops.video },
    lastImport: importLog,
    mosaic: {
      tiles: mosaic.tiles.length, coverage: +mosaic.coverage().toFixed(3), bbox: mosaic.bbox(),
      list: mosaic.tiles.map((t) => ({ id: t.id, b: t.batch, x: t.x, y: t.y, w: t.w, h: t.h, conf: t.conf == null ? null : +t.conf.toFixed(2), weak: !!t.weak, placed: t.placed, t: t.vt == null ? null : +t.vt.toFixed(2) })),
    },
  };
}
$('#btnDiag').onclick = async () => {
  const text = JSON.stringify(diagnostics());
  try {
    await navigator.clipboard.writeText(text);
    toast('診断情報をコピーしました。チャットなどに貼り付けて送ってください', 5000);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* */ }
    ta.remove();
    toast(ok ? '診断情報をコピーしました' : 'コピーできませんでした', 4000);
  }
};

// ---------- 起動 ----------
async function boot() {
  updateStats();
  view.resize();
  view.fit();
  if (await store.hasProject()) {
    const dlg = $('#dlgRestore');
    const go = await new Promise((res) => {
      $('#restoreGo').onclick = () => { dlg.close(); res(true); };
      $('#restoreNew').onclick = () => { dlg.close(); res(false); };
      dlg.oncancel = () => res(true);
      dlg.showModal();
    });
    if (go) {
      setBusy(true);
      prog.open('前回の作業を読み込んでいます…');
      try {
        await store.load(stitcher, (p) => prog.set(p));
        view.fit();
      } catch (err) {
        console.error(err);
        toast('前回の作業を読み込めませんでした', 5000);
      } finally {
        prog.close();
        setBusy(false);
      }
    } else {
      await store.clear();
      await jobs.clear();
    }
  }
  // 前回、動画の取り込みの途中でページが止まっていたら、続きから取り込めるようにする
  const job = await jobs.load();
  if (job && (mosaic.tiles.length || job.meta.wasEmpty)) {
    const m = job.meta, total = m.keys.length;
    $('#rsBody').textContent = `動画「${m.name}」の取り込みが途中（${Math.min(m.next, total)} / ${total} コマ）で止まっていました。別の画面を見ている間にブラウザが止めた可能性があります。続きから取り込みますか？`;
    const dlg = $('#dlgResume');
    const go = await new Promise((res) => {
      $('#rsGo').onclick = () => { dlg.close(); res(true); };
      $('#rsDiscard').onclick = () => { dlg.close(); res(false); };
      dlg.oncancel = (e) => e.preventDefault();
      dlg.showModal();
    });
    if (go) addVideo(job.blob, { ...m, next: m.next });
    else await jobs.clear();
  } else if (job) {
    await jobs.clear();
  }
  checkNativePending();
}
boot();

if ('serviceWorker' in navigator && location.protocol === 'https:' && !isNative) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// テスト・デバッグ用
window.largepic = { mosaic, view, stitcher, settings, store, trim, computeTrim, viewer, importLog, diagnostics };
