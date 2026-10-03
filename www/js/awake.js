// 裏に回っても処理が止まりにくくするための道具
//  - keepAwake: 処理中は画面を消さない（Screen Wake Lock）。画面が消えると、ブラウザは処理を止めてしまう
//  - yieldNow / sleep: 別のタブやアプリを見ている間も遅くならない待ち方
//      ふつうの setTimeout は、裏のタブでは 1 秒に 1 回などに間引かれる（さらに長引くと 1 分に 1 回）。
//      MessageChannel と Worker のタイマーは間引かれないので、処理が進み続ける。

let lock = null, want = 0;

async function acquire() {
  try {
    if (!lock && 'wakeLock' in navigator) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    }
  } catch { /* 対応していない・許可されない端末もある */ }
}
export function keepAwake(on) {
  if (on) { want++; acquire(); return; }
  want = Math.max(0, want - 1);
  if (!want && lock) { lock.release().catch(() => {}); lock = null; }
}
// 画面に戻ったら、取り直す（切り替えると自動で解除されるため）
document.addEventListener('visibilitychange', () => { if (!document.hidden && want) acquire(); });

// 次のタスクまで譲る（表示中は setTimeout、裏では MessageChannel）
let mc = null, waiting = [];
export function yieldNow() {
  if (!document.hidden) return new Promise((r) => setTimeout(r, 0));
  if (!mc) {
    mc = new MessageChannel();
    mc.port1.onmessage = () => { const w = waiting; waiting = []; for (const f of w) f(); };
  }
  return new Promise((r) => { waiting.push(r); mc.port2.postMessage(0); });
}

// 時間待ち（裏でも間引かれない）
let worker = null, seq = 0;
const pending = new Map();
export function sleep(ms) {
  try {
    if (!worker) {
      const src = 'onmessage=(e)=>{const{id,ms}=e.data;setTimeout(()=>postMessage(id),ms)}';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = (e) => { const r = pending.get(e.data); if (r) { pending.delete(e.data); r(); } };
    }
    return new Promise((res) => { const id = ++seq; pending.set(id, res); worker.postMessage({ id, ms }); });
  } catch {
    return new Promise((r) => setTimeout(r, ms));
  }
}
