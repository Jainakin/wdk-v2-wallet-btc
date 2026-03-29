/**
 * Simple LRU cache and concurrency limiter.
 * Matches production patterns:
 *   - LRU cache for tx lookups (avoid re-fetching same tx)
 *   - pLimit-style concurrency control for parallel requests
 */

/**
 * Bounded LRU cache.
 * When the cache exceeds maxSize, the least-recently-used entries are evicted.
 */
export class LRUCache<K, V> {
  private cache = new Map<K, V>();

  constructor(private readonly maxSize: number = 100) {}

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // Delete first so it moves to end
    this.cache.delete(key);
    this.cache.set(key, value);

    // Evict oldest entries if over capacity
    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Concurrency limiter — limits the number of concurrent async operations.
 * Matches production pLimit(8) pattern for fetching transaction details.
 *
 * Usage:
 *   const limit = new ConcurrencyLimiter(8);
 *   const results = await Promise.all(
 *     items.map(item => limit.run(() => fetchItem(item)))
 *   );
 */
export class ConcurrencyLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number = 8) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Wait if at capacity
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      // Release next queued task
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
