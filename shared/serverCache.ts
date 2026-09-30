/**
 * In-memory LRU-like cache for the Node/Vercel server.
 *
 * Slashes Firestore read volume for invariant / slow-changing records:
 * - lectures/{lectureId} (cached 5m)
 * - settings/simosan (cached 5m)
 * - aiFiles/{lectureId} (cached 1h)
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class ServerCache {
  private cache = new Map<string, CacheEntry<any>>();

  get<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    // Basic bounds limit to prevent unbounded memory growth in long-running processes
    if (this.cache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of this.cache.entries()) {
        if (now > v.expiresAt) {
          this.cache.delete(k);
        }
      }
      if (this.cache.size > 2000) {
        // Evict oldest 200 entries
        let count = 0;
        for (const k of this.cache.keys()) {
          this.cache.delete(k);
          if (++count >= 200) break;
        }
      }
    }

    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const serverCache = new ServerCache();
