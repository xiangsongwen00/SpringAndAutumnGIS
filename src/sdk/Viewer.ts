import { GlobeEngine, type GlobeEngineOptions } from '../engine/GlobeEngine';
import { UrlTemplateRasterProvider, type RasterTileProvider } from '../core/tiles/RasterTileProvider';
import { GpuVectorTileProvider } from '../core/tiles/GpuVectorTileProvider';
import { MvtVectorLayer } from '../render/MvtVectorLayer';
import type { MapStyle } from '../vector/style/VectorStyleTypes';
import type { MapStyleCapabilityReport } from '../vector/style/MapStyleLoader';
import type { TerrainProvider } from '../core/terrain/TerrainProvider';
import type { GlobeFlyToOptions } from '../engine/GlobeCameraController';

export type BaseMapDefinition =
  | { id: string; type: 'xyz'; url: string; scheme?: 'xyz' | 'tms'; minLevel?: number;
      maxLevel?: number; levelOffset?: number | null; attribution?: string }
  | { id: string; type: 'provider'; provider: RasterTileProvider }
  | { id: string; type: 'vector-style'; style: string | MapStyle; sourceId?: string;
      levelOffset?: number; symbols?: boolean; fetcher?: typeof fetch };

export type ViewerOptions = Omit<GlobeEngineOptions, 'container' | 'imagery' | 'terrain' | 'terrainEnabled'> & {
  basemaps?: readonly BaseMapDefinition[];
  /** Omitted selects the first definition; null starts without a base map. */
  baseMap?: string | null;
  terrain?: false | { provider: TerrainProvider; enabled?: boolean };
  showLodGrid?: boolean;
  autoStart?: boolean;
  /** Cancels creation/configuration loading; not the lifetime of a ready Viewer. */
  signal?: AbortSignal;
};

export type ViewerErrorCode = 'INVALID_OPTIONS' | 'DESTROYED' | 'ABORTED' | 'BASEMAP_LOAD_FAILED' | 'TERRAIN_UNAVAILABLE';
export class ViewerError extends Error {
  constructor(readonly code: ViewerErrorCode, message: string) { super(message); this.name = 'ViewerError'; }
}
export type BaseMapState = Readonly<{ id: string | null; type: BaseMapDefinition['type'] | null;
  capabilities: MapStyleCapabilityReport | null }>;
type PreparedBaseMap = { provider: RasterTileProvider; symbols?: MvtVectorLayer; dispose: () => void };
const SYMBOL_LAYER = '__sdk_base_labels';

/** Public browser SDK facade. create() means configuration ready, not tile loading complete. */
export class Viewer {
  readonly engine: GlobeEngine;
  private readonly definitions = new Map<string, BaseMapDefinition>();
  private current: PreparedBaseMap | null = null;
  private state: BaseMapState = { id: null, type: null, capabilities: null };
  private controller: AbortController | null = null;
  private generation = 0;
  private destroyed = false;

  private constructor(container: HTMLElement, options: ViewerOptions) {
    const { basemaps = [], baseMap: _baseMap, terrain, showLodGrid = false, autoStart: _autoStart, signal: _signal, ...engineOptions } = options;
    for (const definition of basemaps) this.definitions.set(definition.id, definition);
    this.engine = new GlobeEngine({ ...engineOptions, container, imagery: false,
      terrain: terrain ? terrain.provider : false, terrainEnabled: terrain ? terrain.enabled ?? true : false,
      grid: { ...engineOptions.grid, visible: showLodGrid } });
  }

  static async create(container: string | HTMLElement, options: ViewerOptions = {}): Promise<Viewer> {
    if (typeof document === 'undefined') throw new ViewerError('INVALID_OPTIONS', 'Viewer requires a browser DOM and WebGL.');
    const element = typeof container === 'string' ? document.getElementById(container) : container;
    const containerView = element?.ownerDocument?.defaultView;
    if (!element || !containerView || !(element instanceof containerView.HTMLElement))
      throw new ViewerError('INVALID_OPTIONS', 'A valid container element or element id is required.');
    const ids = new Set<string>();
    for (const definition of options.basemaps ?? []) {
      if (typeof definition.id !== 'string' || !definition.id.trim() || ids.has(definition.id))
        throw new ViewerError('INVALID_OPTIONS', 'Base map ids must be nonempty and unique.');
      if (!['xyz', 'provider', 'vector-style'].includes(definition.type))
        throw new ViewerError('INVALID_OPTIONS', 'Unsupported base map type.');
      if (definition.type === 'provider' && (!definition.provider || typeof definition.provider.url !== 'function'))
        throw new ViewerError('INVALID_OPTIONS', 'A raster provider is required.');
      if (definition.type === 'xyz' && (!definition.url || !['xyz', 'tms'].includes(definition.scheme ?? 'xyz')))
        throw new ViewerError('INVALID_OPTIONS', 'A tile template and valid XYZ/TMS scheme are required.');
      if (definition.type === 'xyz' && (typeof definition.url !== 'string' || !definition.url.includes('{z}') ||
          !definition.url.includes('{x}') || (!definition.url.includes('{y}') && !definition.url.includes('{-y}'))))
        throw new ViewerError('INVALID_OPTIONS', 'Tile template must include z/x and y or -y placeholders.');
      if (definition.type === 'vector-style' && !definition.style)
        throw new ViewerError('INVALID_OPTIONS', 'A style object or URL is required.');
      ids.add(definition.id);
    }
    const initial = options.baseMap === undefined ? options.basemaps?.[0]?.id ?? null : options.baseMap;
    if (initial !== null && !ids.has(initial)) throw new ViewerError('INVALID_OPTIONS', 'Unknown initial base map id.');
    if (options.terrain && !options.terrain.provider)
      throw new ViewerError('INVALID_OPTIONS', 'Terrain configuration requires a provider.');
    if (options.initialView && (!Object.values(options.initialView).every(Number.isFinite) ||
        Math.abs(options.initialView.latitude) > 90 || options.initialView.altitude < 0))
      throw new ViewerError('INVALID_OPTIONS', 'Initial view requires finite coordinates, valid latitude and nonnegative altitude.');
    if (options.signal?.aborted) throw new ViewerError('ABORTED', 'Viewer creation was cancelled.');
    const viewer = new Viewer(element, options);
    const abort = () => viewer.destroy();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      await viewer.setBaseMap(initial);
      if (options.autoStart !== false) viewer.start();
      return viewer;
    } catch (error) { viewer.destroy(); throw error; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }

  get isDestroyed(): boolean { return this.destroyed; }
  get baseMap(): BaseMapState { return this.state; }
  get terrainEnabled(): boolean { return this.engine.terrain?.enabled ?? false; }
  get lodGridVisible(): boolean { return this.engine.grid.object3d.visible; }
  getBaseMaps(): readonly Readonly<BaseMapDefinition>[] { return [...this.definitions.values()].map(item => ({ ...item })); }

  async setBaseMap(id: string | null): Promise<BaseMapState> {
    this.assertAlive();
    const definition = id === null ? null : this.definitions.get(id);
    if (id !== null && !definition) throw new ViewerError('INVALID_OPTIONS', 'Unknown base map id.');
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController(); this.controller = controller;
    let prepared: PreparedBaseMap | null = null;
    try {
      if (definition) prepared = await this.prepare(definition, controller.signal);
      if (controller.signal.aborted || this.destroyed || generation !== this.generation)
        throw new ViewerError('ABORTED', 'Base map switch was superseded or cancelled.');
      // Prepare completely before mutating either base layer; business layers are untouched.
      this.engine.replaceBaseImagery(prepared?.provider ?? null);
      this.engine.removeVectorLayer(SYMBOL_LAYER);
      if (prepared?.symbols) this.engine.addVectorLayer(SYMBOL_LAYER, prepared.symbols);
      const previous = this.current;
      this.current = prepared; prepared = null;
      previous?.dispose();
      this.state = Object.freeze({ id, type: definition?.type ?? null,
        capabilities: this.current?.provider instanceof GpuVectorTileProvider ? this.current.provider.capabilityReport : null });
      return this.state;
    } catch (error) {
      prepared?.dispose();
      if (error instanceof ViewerError) throw error;
      if (controller.signal.aborted) throw new ViewerError('ABORTED', 'Base map switch was cancelled.');
      // Do not copy URL/token-bearing backend error strings into the public error.
      throw new ViewerError('BASEMAP_LOAD_FAILED', 'Base map configuration could not be loaded.');
    } finally { if (this.controller === controller) this.controller = null; }
  }

  setTerrainEnabled(enabled: boolean): void {
    this.assertAlive();
    if (enabled && !this.engine.terrain) throw new ViewerError('TERRAIN_UNAVAILABLE', 'Configure a terrain provider at creation before enabling terrain.');
    this.engine.setTerrainEnabled(enabled);
  }
  setLodGridVisible(visible: boolean): void { this.assertAlive(); this.engine.setLodGridVisible(visible); }
  flyTo(view: GlobeFlyToOptions): void { this.assertAlive(); this.engine.flyTo(view); }
  getCameraViewState() { this.assertAlive(); return this.engine.getCameraViewState(); }
  start(): void { this.assertAlive(); this.engine.start(); }
  stop(): void { this.assertAlive(); this.engine.stop(); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.generation++; this.controller?.abort(); this.controller = null;
    this.engine.dispose(); this.current?.dispose(); this.current = null;
  }
  private assertAlive(): void { if (this.destroyed) throw new ViewerError('DESTROYED', 'Viewer has been destroyed.'); }

  private async prepare(definition: BaseMapDefinition, signal: AbortSignal): Promise<PreparedBaseMap> {
    if (definition.type === 'provider') return { provider: definition.provider, dispose: () => {} };
    if (definition.type === 'xyz') {
      // {-y} explicitly denotes inverted XYZ row; do not invert it a second time.
      const url = definition.scheme === 'tms' && !definition.url.includes('{-y}')
        ? definition.url.replace(/\{y\}/g, '{-y}') : definition.url;
      return { provider: new UrlTemplateRasterProvider({ id: definition.id, urlTemplate: url,
        minLevel: definition.minLevel, maxLevel: definition.maxLevel, viewLevelOffset: definition.levelOffset,
        attribution: definition.attribution }), dispose: () => {} };
    }
    const fetcher: typeof fetch = (input, init) => (definition.fetcher ?? fetch).call(globalThis, input,
      { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
    const provider = new GpuVectorTileProvider({ id: definition.id, renderer: this.engine.renderer,
      ...(typeof definition.style === 'string' ? { styleUrl: definition.style } : { style: definition.style }),
      sourceId: definition.sourceId, levelOffset: definition.levelOffset, fetcher, workBudget: this.engine.backgroundWorkBudget });
    let symbols: MvtVectorLayer | undefined, released = false;
    const dispose = () => { if (!released) { released = true; symbols?.dispose(); provider.dispose(); } };
    const cancelled = () => dispose();
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      await cancellable(provider.initialize(), signal);
      if (definition.symbols !== false) {
        symbols = new MvtVectorLayer(this.engine.ellipsoid, { id: SYMBOL_LAYER, role: 'base',
          ...(typeof definition.style === 'string' ? { styleUrl: definition.style } : { style: definition.style }),
          sourceId: definition.sourceId, symbols: true, symbolsOnly: true, terrain: this.engine.terrain ?? undefined,
          levelOffset: definition.levelOffset, order: 10000, maxConcurrentRequests: 1, maxCachedTiles: 64,
          maxLabelsPerTile: 8, maxVisibleLabels: 64, maxAllocatedLabels: 256, fetcher,
          decodedTileLoader: (id, requestSignal) => provider.loadVectorTile(id, requestSignal) });
        await cancellable(symbols.initialize(), signal);
      }
      signal.throwIfAborted();
      return { provider, symbols, dispose };
    } catch (error) { dispose(); throw error; }
    finally { signal.removeEventListener('abort', cancelled); }
  }
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ViewerError('ABORTED', 'Base map switch was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
