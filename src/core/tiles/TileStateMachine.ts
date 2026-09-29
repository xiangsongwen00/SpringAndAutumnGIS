export type TileContentKind =
  | 'imagery'
  | 'rasterized-vector'
  | 'terrain'
  | 'vector'
  | 'model';

export type TileContentState =
  | 'unloaded'
  | 'queued'
  | 'loading'
  | 'decoding'
  | 'uploading'
  | 'ready'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type TileContentKey = Readonly<{
  sourceId: string;
  kind: TileContentKind;
  level: number;
  x: number;
  y: number;
  variant?: string;
}>;

export type TileRecord = Readonly<{
  key: TileContentKey;
  id: string;
  state: TileContentState;
  priority: number;
  attempts: number;
  error: string | null;
  byteSize: number;
  references: number;
  lastAccessFrame: number;
  updatedAt: number;
}>;

export type TileRecordPatch = Readonly<
  Partial<Pick<TileRecord, 'priority' | 'attempts' | 'error' | 'byteSize' | 'lastAccessFrame'>>
>;

export type TileStateChange = Readonly<{
  id: string;
  previous: TileContentState | null;
  record: TileRecord;
}>;

export type TileStateListener = (change: TileStateChange) => void;

const TRANSITIONS: Readonly<Record<TileContentState, readonly TileContentState[]>> = {
  unloaded: ['queued', 'cancelled'],
  queued: ['loading', 'cancelled', 'failed'],
  loading: ['decoding', 'uploading', 'ready', 'failed', 'cancelled'],
  decoding: ['uploading', 'ready', 'failed', 'cancelled'],
  uploading: ['ready', 'failed', 'cancelled'],
  ready: ['expired', 'cancelled'],
  failed: ['queued', 'unloaded', 'cancelled'],
  expired: ['queued', 'unloaded', 'cancelled'],
  cancelled: ['queued', 'unloaded']
};

/**
 * Lifecycle registry for one source/content/tile/variant tuple.
 *
 * It deliberately owns no network or GPU object. Consumers can therefore share
 * lifecycle and coverage decisions without coupling the GIS core to Three.js.
 */
export class TileStateMachine {
  private readonly records = new Map<string, TileRecord>();
  private readonly listeners = new Set<TileStateListener>();

  get size(): number {
    return this.records.size;
  }

  values(): readonly TileRecord[] {
    return [...this.records.values()];
  }

  get(key: TileContentKey): TileRecord | undefined {
    return this.records.get(tileContentId(key));
  }

  ensure(key: TileContentKey, patch: TileRecordPatch = {}): TileRecord {
    validateKey(key);
    const id = tileContentId(key);
    const current = this.records.get(id);
    if (current) return this.patchRecord(current, patch);
    const record: TileRecord = Object.freeze({
      key: freezeKey(key),
      id,
      state: 'unloaded',
      priority: patch.priority ?? Number.POSITIVE_INFINITY,
      attempts: patch.attempts ?? 0,
      error: patch.error ?? null,
      byteSize: normalizeNonNegative(patch.byteSize ?? 0, 'byteSize'),
      references: 0,
      lastAccessFrame: normalizeNonNegative(patch.lastAccessFrame ?? 0, 'lastAccessFrame'),
      updatedAt: Date.now()
    });
    this.records.set(id, record);
    this.emit(null, record);
    return record;
  }

  transition(
    key: TileContentKey,
    state: TileContentState,
    patch: TileRecordPatch = {}
  ): TileRecord {
    const current = this.ensure(key);
    if (current.state === state) return this.patchRecord(current, patch);
    if (!TRANSITIONS[current.state].includes(state)) {
      throw new Error(`Invalid tile transition ${current.state} -> ${state}: ${current.id}`);
    }
    const next = this.replace(current, {
      ...patch,
      state,
      error: state === 'failed' ? patch.error ?? current.error : patch.error ?? null,
      attempts: state === 'loading' ? current.attempts + 1 : patch.attempts ?? current.attempts
    });
    this.emit(current.state, next);
    return next;
  }

  retain(key: TileContentKey): TileRecord {
    const current = this.ensure(key);
    return this.replace(current, { references: current.references + 1 });
  }

  release(key: TileContentKey): TileRecord | undefined {
    const current = this.get(key);
    if (!current) return undefined;
    return this.replace(current, { references: Math.max(0, current.references - 1) });
  }

  touch(key: TileContentKey, frame: number): TileRecord {
    return this.patchRecord(this.ensure(key), { lastAccessFrame: frame });
  }

  remove(key: TileContentKey, force = false): boolean {
    const current = this.get(key);
    if (!current) return false;
    if (!force && current.references > 0) return false;
    return this.records.delete(current.id);
  }

  resolveReadyAncestor(key: TileContentKey, minimumLevel = 0): TileRecord | undefined {
    validateKey(key);
    for (let level = key.level; level >= minimumLevel; level -= 1) {
      const divisor = 2 ** (key.level - level);
      const candidate = this.get({
        ...key,
        level,
        x: Math.floor(key.x / divisor),
        y: Math.floor(key.y / divisor)
      });
      if (candidate?.state === 'ready') return candidate;
    }
    return undefined;
  }

  /** A parent may retire only when all four direct children are ready. */
  canReplaceWithChildren(parent: TileContentKey): boolean {
    const level = parent.level + 1;
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        const child = this.get({
          ...parent,
          level,
          x: parent.x * 2 + dx,
          y: parent.y * 2 + dy
        });
        if (child?.state !== 'ready') return false;
      }
    }
    return true;
  }

  subscribe(listener: TileStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private patchRecord(current: TileRecord, patch: TileRecordPatch): TileRecord {
    if (Object.keys(patch).length === 0) return current;
    return this.replace(current, patch);
  }

  private replace(current: TileRecord, patch: Partial<TileRecord>): TileRecord {
    const next: TileRecord = Object.freeze({
      ...current,
      ...patch,
      byteSize: normalizeNonNegative(patch.byteSize ?? current.byteSize, 'byteSize'),
      lastAccessFrame: normalizeNonNegative(
        patch.lastAccessFrame ?? current.lastAccessFrame,
        'lastAccessFrame'
      ),
      updatedAt: Date.now()
    });
    this.records.set(current.id, next);
    return next;
  }

  private emit(previous: TileContentState | null, record: TileRecord): void {
    const change: TileStateChange = { id: record.id, previous, record };
    for (const listener of this.listeners) listener(change);
  }
}

export function tileContentId(key: TileContentKey): string {
  validateKey(key);
  return [
    encodeURIComponent(key.sourceId),
    key.kind,
    key.level,
    key.x,
    key.y,
    encodeURIComponent(key.variant ?? '')
  ].join('/');
}

function freezeKey(key: TileContentKey): TileContentKey {
  return Object.freeze({ ...key });
}

function validateKey(key: TileContentKey): void {
  if (!key.sourceId.trim()) throw new Error('Tile sourceId is required.');
  for (const [name, value] of [['level', key.level], ['x', key.x], ['y', key.y]] as const) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`Tile ${name} must be a non-negative integer.`);
  }
  const size = 2 ** key.level;
  if (key.x >= size || key.y >= size) {
    throw new Error(`Tile coordinate is outside level ${key.level}: ${key.x}/${key.y}`);
  }
}

function normalizeNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative.`);
  return value;
}
