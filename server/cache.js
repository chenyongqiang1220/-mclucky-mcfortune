'use strict';

/**
 * 极简内存缓存（TTL + 容量上限）
 *
 * 麦当劳 MCP 单次调用 300ms~2s，菜单这种大 payload 没必要每次重拉。
 * 门店菜单 10 分钟内基本不变，缓存后重复求签能压到 1 秒内。
 */
class TtlCache {
  constructor({ max = 200 } = {}) {
    this.map = new Map();
    this.max = max;
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expire) {
      this.map.delete(key);
      return undefined;
    }
    // LRU：命中后挪到末尾
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expire: Date.now() + ttlMs });
    return value;
  }

  /** 命中就返回，未命中则调用 fn 并写入 */
  async wrap(key, ttlMs, fn) {
    const cached = this.get(key);
    if (cached !== undefined) return { value: cached, hit: true };
    const value = await fn();
    this.set(key, value, ttlMs);
    return { value, hit: false };
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { TtlCache };
