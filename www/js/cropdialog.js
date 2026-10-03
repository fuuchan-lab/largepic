// 切り抜き範囲（検索バーやボタンなど、動かない部分を除外）の設定ダイアログ
import { newCanvas } from './imageutil.js';

export const PRESETS = {
  none: { top: 0, bottom: 0, left: 0, right: 0 },
  phone: { top: 0.13, bottom: 0.14, left: 0, right: 0 },
  desktop: { top: 0.08, bottom: 0.03, left: 0, right: 0 },
};

// opts.video を渡すと、取り込む区間（開始・終了）も選べる
// 戻り値: { crop, start, end } またはキャンセル時 null
export function editCrop(dlg, source, sw, sh, initial, opts = {}) {
  return new Promise((resolve) => {
    const canvas = dlg.querySelector('canvas');
    const crop = { ...initial };
    const video = opts.video || null;
    const rangeBox = dlg.querySelector('.range');
    const inS = dlg.querySelector('[data-start]'), inE = dlg.querySelector('[data-end]');
    const outS = dlg.querySelector('[data-start-out]'), outE = dlg.querySelector('[data-end-out]');
    let start = 0, end = video ? video.duration : 0;
    // 記録しない領域（動かない物）：切り抜いた範囲に対する割合
    // 複数指定できる。編集用の写しを持ち、［この範囲で続ける］で返す
    const masks = (opts.masks || []).map((m) => ({ ...m }));
    let enabled = masks.length > 0, active = Math.max(0, masks.length - 1);
    const newMask = () => ({ shape: 'ellipse', cx: 0.5, cy: 0.5, rw: 0.12, rh: 0.07 });
    const maskOn = dlg.querySelector('#maskOn'), maskCtl = dlg.querySelector('#maskCtl');
    const maskShapeBtns = dlg.querySelectorAll('#maskShape button');
    const maskDetect = dlg.querySelector('#maskDetect'), maskMsg = dlg.querySelector('#maskMsg');
    const maskAdd = dlg.querySelector('#maskAdd'), maskDel = dlg.querySelector('#maskDel');
    const MSG0 = '赤い範囲をタップで選び、ドラッグで動かし、右下の●で大きさを変えます。縮尺バーやアイコンなども［追加］で指定できます。この範囲は記録せず、画面が動いたあとの絵で埋めます。';
    // 元画像を縮小して保持
    const maxW = Math.min(window.innerWidth - 48, 520);
    const maxH = Math.min(window.innerHeight * 0.58, 640);
    const s = Math.min(maxW / sw, maxH / sh);
    const cw = Math.round(sw * s), ch = Math.round(sh * s);
    const img = newCanvas(cw, ch);
    const grab = () => img.getContext('2d').drawImage(source, 0, 0, sw, sh, 0, 0, cw, ch);
    grab();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cw * dpr; canvas.height = ch * dpr;
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    const ctx = canvas.getContext('2d');

    const edges = () => ({
      top: crop.top * ch, bottom: ch - crop.bottom * ch,
      left: crop.left * cw, right: cw - crop.right * cw,
    });

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(img, 0, 0);
      const e = edges();
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(0, 0, cw, e.top);
      ctx.fillRect(0, e.bottom, cw, ch - e.bottom);
      ctx.fillRect(0, e.top, e.left, e.bottom - e.top);
      ctx.fillRect(e.right, e.top, cw - e.right, e.bottom - e.top);
      ctx.strokeStyle = '#3da5ff'; ctx.lineWidth = 2;
      ctx.strokeRect(e.left, e.top, e.right - e.left, e.bottom - e.top);
      ctx.fillStyle = '#3da5ff';
      const hx = (e.left + e.right) / 2, hy = (e.top + e.bottom) / 2;
      const knob = (x, y, w, h) => { ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 4); ctx.fill(); };
      knob(hx, e.top, 44, 10); knob(hx, e.bottom, 44, 10);
      knob(e.left, hy, 10, 44); knob(e.right, hy, 10, 44);
      if (enabled) {
        masks.forEach((mk, i) => {
          const m = maskBox(mk, e);
          ctx.save();
          ctx.fillStyle = i === active ? 'rgba(255,60,60,0.32)' : 'rgba(255,60,60,0.20)';
          ctx.strokeStyle = i === active ? '#ff4d4d' : 'rgba(255,120,120,0.8)'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
          ctx.beginPath();
          if (mk.shape === 'rect') ctx.rect(m.cx - m.rx, m.cy - m.ry, m.rx * 2, m.ry * 2); else ctx.ellipse(m.cx, m.cy, m.rx, m.ry, 0, 0, Math.PI * 2);
          ctx.fill(); ctx.stroke();
          ctx.setLineDash([]);
          if (i === active) { ctx.fillStyle = '#ff4d4d'; ctx.beginPath(); ctx.arc(m.cx + m.rx, m.cy + m.ry, 9, 0, Math.PI * 2); ctx.fill(); }   // 大きさを変える●
          ctx.restore();
        });
      }
    }
    // マスクのプレビュー上の位置（切り抜き範囲の中での割合）
    function maskBox(mk, e = edges()) {
      const w = e.right - e.left, h = e.bottom - e.top;
      return { cx: e.left + mk.cx * w, cy: e.top + mk.cy * h, rx: mk.rw * w, ry: mk.rh * h, w, h, left: e.left, top: e.top };
    }

    let drag = null, maskGrab = null;
    const pos = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    const down = (ev) => {
      const p = pos(ev), e = edges();
      if (enabled && masks.length) {
        // 選んでいる範囲の●（大きさ変更）を最優先、次に範囲の中（手前＝あとから追加したものを優先）
        const am = maskBox(masks[active], e);
        if (Math.hypot(p.x - (am.cx + am.rx), p.y - (am.cy + am.ry)) < 22) { drag = 'mask-size'; canvas.setPointerCapture(ev.pointerId); return; }
        for (let i = masks.length - 1; i >= 0; i--) {
          const m = maskBox(masks[i], e);
          const dx = (p.x - m.cx) / (m.rx + 8), dy = (p.y - m.cy) / (m.ry + 8);
          if (dx * dx + dy * dy <= 1 || (masks[i].shape === 'rect' && Math.abs(p.x - m.cx) < m.rx + 8 && Math.abs(p.y - m.cy) < m.ry + 8)) {
            active = i; syncMask(); draw();
            drag = 'mask-move'; maskGrab = { dx: p.x - m.cx, dy: p.y - m.cy }; canvas.setPointerCapture(ev.pointerId); return;
          }
        }
      }
      const d = [
        ['top', Math.abs(p.y - e.top)], ['bottom', Math.abs(p.y - e.bottom)],
        ['left', Math.abs(p.x - e.left)], ['right', Math.abs(p.x - e.right)],
      ].sort((a, b) => a[1] - b[1])[0];
      if (d[1] < 36) { drag = d[0]; canvas.setPointerCapture(ev.pointerId); }
    };
    const move = (ev) => {
      if (!drag) return;
      const p = pos(ev);
      const cl = (v, max) => Math.max(0, Math.min(max, v));
      if (drag === 'mask-move' || drag === 'mask-size') {
        const mk = masks[active], m = maskBox(mk);
        if (drag === 'mask-move') {
          mk.cx = Math.max(0, Math.min(1, (p.x - maskGrab.dx - m.left) / m.w));
          mk.cy = Math.max(0, Math.min(1, (p.y - maskGrab.dy - m.top) / m.h));
        } else {
          mk.rw = Math.max(0.02, Math.min(0.5, (p.x - m.cx) / m.w));
          mk.rh = Math.max(0.02, Math.min(0.5, (p.y - m.cy) / m.h));
        }
        draw();
        return;
      }
      if (drag === 'top') crop.top = cl(p.y / ch, 0.9 - crop.bottom);
      if (drag === 'bottom') crop.bottom = cl(1 - p.y / ch, 0.9 - crop.top);
      if (drag === 'left') crop.left = cl(p.x / cw, 0.9 - crop.right);
      if (drag === 'right') crop.right = cl(1 - p.x / cw, 0.9 - crop.left);
      draw();
    };
    const up = () => { drag = null; };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    const presetBtns = dlg.querySelectorAll('[data-preset]');
    const onPreset = (ev) => { Object.assign(crop, PRESETS[ev.currentTarget.dataset.preset]); draw(); };
    presetBtns.forEach((b) => b.addEventListener('click', onPreset));

    // 記録しない領域の操作
    const syncMask = () => {
      maskOn.checked = enabled;
      maskCtl.hidden = !enabled;
      const cur = masks[active];
      maskShapeBtns.forEach((b) => b.classList.toggle('on', !!cur && b.dataset.v === cur.shape));
      maskDetect.hidden = !(enabled && video && opts.detect);
      maskDel.disabled = !masks.length;
    };
    const onMaskOn = () => {
      enabled = maskOn.checked;
      if (enabled && !masks.length) { masks.push(newMask()); active = 0; }
      maskMsg.textContent = MSG0; syncMask(); draw();
    };
    const onShape = (ev) => { if (masks[active]) masks[active].shape = ev.currentTarget.dataset.v; syncMask(); draw(); };
    const onAdd = () => {
      const mk = newMask();
      // 重ならないよう、少しずつずらして置く
      mk.cx = 0.5 + 0.12 * (masks.length % 4) - 0.18; mk.cy = 0.5 + 0.14 * (masks.length % 3) - 0.14;
      masks.push(mk); active = masks.length - 1; syncMask(); draw();
    };
    const onDel = () => {
      if (!masks.length) return;
      masks.splice(active, 1); active = Math.max(0, Math.min(active, masks.length - 1));
      if (!masks.length) enabled = false;
      syncMask(); draw();
    };
    const onDetect = async () => {
      maskDetect.disabled = true; const label = maskDetect.textContent; maskDetect.textContent = '探しています…';
      maskMsg.textContent = '動画を調べて、画面の同じ位置に居続ける物（キャラクター・縮尺バー・アイコンなど）を探しています…';
      try {
        const r = await opts.detect({ ...crop }, { onProgress: (p) => { maskDetect.textContent = `探しています… ${Math.round(p * 100)}%`; } });
        if (r.found) {
          masks.splice(0, masks.length, ...r.masks.map((m) => ({ ...m })));
          active = 0; enabled = true;
          maskMsg.textContent = `${masks.length}か所見つかりました。赤い範囲を確かめて、ずれていれば動かしてください。いらないものは［削除］で消せます。`;
        } else maskMsg.textContent = r.reason || '見つかりませんでした。';
      } catch (e) {
        console.warn(e); maskMsg.textContent = '自動で見つけられませんでした。範囲を自分で指定してください。';
      } finally {
        maskDetect.disabled = false; maskDetect.textContent = label; syncMask(); draw();
        try { video.currentTime = Math.min(start, video.duration); } catch { /* */ }
      }
    };
    maskOn.addEventListener('change', onMaskOn);
    maskShapeBtns.forEach((b) => b.addEventListener('click', onShape));
    maskDetect.addEventListener('click', onDetect);
    maskAdd.addEventListener('click', onAdd);
    maskDel.addEventListener('click', onDel);
    maskMsg.textContent = MSG0;
    syncMask();

    // 区間スライダー（動画のみ）
    rangeBox.hidden = !video;
    let seeking = Promise.resolve();
    const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
    const showAt = (t) => {
      seeking = seeking.then(() => new Promise((res) => {
        const done = () => { clearTimeout(to); grab(); draw(); res(); };
        const to = setTimeout(done, 1500);
        video.addEventListener('seeked', done, { once: true });
        video.currentTime = t;
      }));
    };
    const onRange = (ev) => {
      start = parseFloat(inS.value); end = parseFloat(inE.value);
      if (end - start < 0.5) {
        if (ev.target === inS) { start = Math.max(0, end - 0.5); inS.value = start; } else { end = Math.min(video.duration, start + 0.5); inE.value = end; }
      }
      outS.textContent = fmt(start); outE.textContent = fmt(end);
      showAt(ev.target === inE ? end : start);
    };
    if (video) {
      const d = video.duration;
      start = Math.min(opts.start ?? 0, d); end = d;
      for (const el of [inS, inE]) { el.min = 0; el.max = d; el.step = 0.1; }
      inS.value = start; inE.value = end;
      outS.textContent = fmt(start); outE.textContent = fmt(end);
      inS.addEventListener('input', onRange);
      inE.addEventListener('input', onRange);
    }

    const finish = (val) => {
      if (video) { inS.removeEventListener('input', onRange); inE.removeEventListener('input', onRange); }
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      presetBtns.forEach((b) => b.removeEventListener('click', onPreset));
      maskOn.removeEventListener('change', onMaskOn);
      maskShapeBtns.forEach((b) => b.removeEventListener('click', onShape));
      maskDetect.removeEventListener('click', onDetect);
      maskAdd.removeEventListener('click', onAdd);
      maskDel.removeEventListener('click', onDel);
      dlg.querySelector('[data-ok]').onclick = null;
      dlg.querySelector('[data-cancel]').onclick = null;
      dlg.onclose = null;
      img.width = img.height = 0;
      if (dlg.open) dlg.close();
      resolve(val);
    };
    dlg.querySelector('[data-ok]').onclick = () => finish({ crop: { ...crop }, start, end, masks: enabled ? masks.map((m) => ({ ...m })) : [] });
    dlg.querySelector('[data-cancel]').onclick = () => finish(null);
    dlg.onclose = () => finish(null);
    draw();
    dlg.showModal();
  });
}
