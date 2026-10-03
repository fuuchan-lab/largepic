// 動画取り込みの「途中経過」を端末に残す。
// 別のアプリを見ている間にブラウザがページを止めたり破棄したりしても、
// 戻ったときに、途中から続きを取り込める（動画ファイルと、選んだコマの一覧を保存しておく）。
const DB = 'largepic-jobs';
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

let current = null;

export const jobs = {
  // 取り込みを始めるとき。保存できなければ false（再開はできないが、取り込み自体は続ける）
  async start(meta, blob) {
    try {
      const db = await open();
      current = { ...meta, next: 0, savedAt: Date.now() };
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(blob, 'video');
      t.objectStore('kv').put(current, 'meta');
      await done(t);
      return true;
    } catch (e) {
      console.warn('途中経過を保存できません', e);
      current = null;
      return false;
    }
  },
  // 次に取り込むコマの番号を記録する
  async progress(next) {
    if (!current) return;
    current.next = next;
    try {
      const db = await open();
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(current, 'meta');
      await done(t);
    } catch { /* 無視 */ }
  },
  async load() {
    try {
      const db = await open();
      const t = db.transaction('kv');
      const meta = await req(t.objectStore('kv').get('meta'));
      if (!meta) return null;
      const blob = await req(db.transaction('kv').objectStore('kv').get('video'));
      return blob ? { meta, blob } : null;
    } catch { return null; }
  },
  async clear() {
    current = null;
    try {
      const db = await open();
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').clear();
      await done(t);
    } catch { /* 無視 */ }
  },
};
