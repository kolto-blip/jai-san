// Счётчик неверных попыток с одного IP в скользящем окне.
// Удачные попытки не сбрасывают счётчик: иначе можно перемежать подбор
// с заведомо верным кодом.
export class FailureLimiter {
  constructor(maxFailures, windowMs) {
    this.max = maxFailures;
    this.windowMs = windowMs;
    this.hits = new Map(); // ip -> [timestamps]
    setInterval(() => this.cleanup(), 60_000).unref();
  }

  recent(ip) {
    const now = Date.now();
    const list = (this.hits.get(ip) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(ip, list);
    else this.hits.delete(ip);
    return list;
  }

  isBlocked(ip) {
    return this.recent(ip).length >= this.max;
  }

  // секунд до разблокировки
  retryAfter(ip) {
    const list = this.recent(ip);
    if (list.length < this.max) return 0;
    return Math.ceil((list[list.length - this.max] + this.windowMs - Date.now()) / 1000);
  }

  fail(ip) {
    const list = this.recent(ip);
    list.push(Date.now());
    this.hits.set(ip, list);
  }

  cleanup() {
    for (const ip of this.hits.keys()) this.recent(ip);
  }
}
