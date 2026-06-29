export class TileCache<T> {
  private readonly _maxEntries: number;
  private readonly _entries = new Map<string, { value: T; lastUsed: number }>();
  private _clock = 0;

  constructor(maxEntries = 256) {
    this._maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  get size(): number {
    return this._entries.size;
  }

  get(key: string): T | undefined {
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    entry.lastUsed = ++this._clock;
    return entry.value;
  }

  set(key: string, value: T): void {
    this._entries.set(key, {
      value,
      lastUsed: ++this._clock
    });
    this.evict();
  }

  has(key: string): boolean {
    return this._entries.has(key);
  }

  delete(key: string): boolean {
    return this._entries.delete(key);
  }

  clear(dispose?: (value: T) => void): void {
    if (dispose) {
      for (const entry of this._entries.values()) {
        dispose(entry.value);
      }
    }
    this._entries.clear();
  }

  private evict(): void {
    while (this._entries.size > this._maxEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Number.POSITIVE_INFINITY;

      for (const [key, entry] of this._entries) {
        if (entry.lastUsed < oldestTime) {
          oldestKey = key;
          oldestTime = entry.lastUsed;
        }
      }

      if (oldestKey === null) return;
      this._entries.delete(oldestKey);
    }
  }
}
