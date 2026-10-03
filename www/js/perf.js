// 処理時間の計測（どこが遅いかを調べるための軽い道具）。診断情報にも入る。
export const perf = {
  t: {}, n: {},
  add(name, ms) { this.t[name] = (this.t[name] || 0) + ms; this.n[name] = (this.n[name] || 0) + 1; },
  async time(name, fn) { const t0 = performance.now(); try { return await fn(); } finally { this.add(name, performance.now() - t0); } },
  timeSync(name, fn) { const t0 = performance.now(); try { return fn(); } finally { this.add(name, performance.now() - t0); } },
  reset() { this.t = {}; this.n = {}; },
  report() { return Object.fromEntries(Object.keys(this.t).map((k) => [k, { ms: Math.round(this.t[k]), n: this.n[k], avg: +(this.t[k] / this.n[k]).toFixed(1) }])); },
};
