import { DEFAULT_LEVEL_OFFSET } from '../tiles/RasterTileProvider';
import type {
  LayerCollectionChange,
  LayerCollectionListener,
  LayerDefinition,
  LayerState,
  LayerStatePatch
} from './LayerTypes';

/** Ordered, observable user-facing layer state. Renderers consume it but do not own it. */
export class LayerCollection implements Iterable<LayerState> {
  private layers: LayerState[] = [];
  private readonly listeners = new Set<LayerCollectionListener>();
  private _revision = 0;

  constructor(initialLayers: readonly LayerDefinition[] = []) {
    for (const layer of initialLayers) this.add(layer, false);
    this.normalizeOrder();
  }

  get revision(): number {
    return this._revision;
  }

  get length(): number {
    return this.layers.length;
  }

  [Symbol.iterator](): Iterator<LayerState> {
    return this.values()[Symbol.iterator]();
  }

  values(): readonly LayerState[] {
    return [...this.layers];
  }

  get(id: string): LayerState | undefined {
    return this.layers.find((layer) => layer.id === id);
  }

  add(definition: LayerDefinition, notify = true): LayerState {
    if (this.get(definition.id)) throw new Error(`Layer already exists: ${definition.id}`);
    const layer = normalizeLayer(definition, this.layers.length);
    if (layer.visible) this.hideExclusivePeers(layer);
    this.layers.push(layer);
    this.sortLayers();
    if (notify) this.emit('add', layer.id);
    return layer;
  }

  remove(id: string): boolean {
    const index = this.layers.findIndex((layer) => layer.id === id);
    if (index < 0) return false;
    this.layers.splice(index, 1);
    this.normalizeOrder();
    this.emit('remove', id);
    return true;
  }

  update(id: string, patch: LayerStatePatch): LayerState {
    const index = this.layers.findIndex((layer) => layer.id === id);
    const current = this.layers[index];
    if (!current || index < 0) throw new Error(`Unknown layer: ${id}`);
    const next = normalizeLayer({ ...current, ...patch }, current.order);
    if (next.visible) this.hideExclusivePeers(next);
    this.layers[index] = next;
    this.sortLayers();
    this.emit(patch.order === undefined ? 'update' : 'reorder', id);
    return next;
  }

  setVisible(id: string, visible: boolean): LayerState {
    return this.update(id, { visible });
  }

  setOpacity(id: string, opacity: number): LayerState {
    return this.update(id, { opacity });
  }

  setLevelOffset(id: string, levelOffset: number): LayerState {
    return this.update(id, { levelOffset });
  }

  move(id: string, order: number): LayerState {
    return this.update(id, { order });
  }

  replace(definitions: readonly LayerDefinition[]): void {
    this.layers = [];
    for (const definition of definitions) this.add(definition, false);
    this.normalizeOrder();
    this.emit('reset');
  }

  subscribe(listener: LayerCollectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  toJSON(): readonly LayerState[] {
    return this.values();
  }

  private hideExclusivePeers(layer: LayerState): void {
    if (!layer.exclusiveGroup) return;
    this.layers = this.layers.map((candidate) =>
      candidate.id !== layer.id &&
      candidate.exclusiveGroup === layer.exclusiveGroup &&
      candidate.visible
        ? { ...candidate, visible: false }
        : candidate
    );
  }

  private sortLayers(): void {
    this.layers.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  private normalizeOrder(): void {
    this.sortLayers();
    this.layers = this.layers.map((layer, order) => ({ ...layer, order }));
  }

  private emit(type: LayerCollectionChange['type'], layerId?: string): void {
    this._revision += 1;
    const change: LayerCollectionChange = { type, layerId, revision: this._revision };
    for (const listener of this.listeners) listener(change);
  }
}

function normalizeLayer(definition: LayerDefinition, fallbackOrder: number): LayerState {
  if (!definition.id.trim()) throw new Error('Layer id is required.');
  if (!definition.sourceId.trim()) throw new Error(`Layer sourceId is required: ${definition.id}`);
  return {
    ...definition,
    visible: definition.visible ?? false,
    opacity: clamp(definition.opacity ?? 1, 0, 1),
    order: Math.max(0, Math.round(definition.order ?? fallbackOrder)),
    levelOffset: normalizeLevelOffset(definition.levelOffset ?? DEFAULT_LEVEL_OFFSET),
    annotationLayerIds: definition.annotationLayerIds
      ? [...definition.annotationLayerIds]
      : undefined
  };
}

function normalizeLevelOffset(value: number): number {
  return Number.isFinite(value) ? clamp(value, -8, 2) : DEFAULT_LEVEL_OFFSET;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
