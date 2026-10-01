import * as THREE from 'three';
import { CoordinateTransform } from '../core/coordinates/CoordinateTransform';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import {
  GlobeLodSelector,
  type GlobeLodSelectorOptions,
  type GlobeLodStats
} from '../core/lod/GlobeLodSelector';
import { GlobeGridRenderer, type GlobeGridRendererOptions } from '../render/GlobeGridRenderer';
import type { RasterTileProvider } from '../core/tiles/RasterTileProvider';
import { TileStateMachine } from '../core/tiles/TileStateMachine';
import { WebMercatorTilingScheme } from '../core/tiling/WebMercatorTilingScheme';
import {
  RasterTileLayer,
  type RasterTileLayerOptions,
  type RasterTileLayerStats
} from '../render/RasterTileLayer';
import type { TerrainProvider } from '../core/terrain/TerrainProvider';
import {
  TerrainTileLayer,
  type TerrainTileLayerOptions,
  type TerrainTileLayerStats
} from '../render/TerrainTileLayer';
import { GeoJsonLayer } from '../render/GeoJsonLayer';
import { MvtVectorLayer, type MvtVectorLayerStats } from '../render/MvtVectorLayer';
import { GpuFrameTimer } from '../render/GpuFrameTimer';
import {
  GlobeCameraController,
  type GlobeCameraViewState,
  type GlobeFlyToOptions
} from './GlobeCameraController';

export type GlobeFramePerformance = Readonly<{
  lodMs: number; terrainMs: number; surfaceMs: number; featureMs: number;
  renderSubmitMs: number; drawCalls: number; triangles: number;
  gpuMs: number | null;
  lodSelections: number;
}>;
export type GlobeEngineStats = GlobeLodStats & Readonly<{
  cameraLevel: number;
  imagery: RasterTileLayerStats | null;
  terrain: TerrainTileLayerStats | null;
  vectorLayers: ReadonlyMap<string, MvtVectorLayerStats>;
  performance: GlobeFramePerformance;
}>;

export type GlobeNavigationOptions = {
  /** Maximum orbit speed used at global scale. */
  rotateSpeed?: number;
  /** Minimum orbit speed close to the surface. */
  minRotateSpeed?: number;
  /** Maximum wheel/pinch speed used at global scale. */
  zoomSpeed?: number;
  /** Minimum wheel/pinch speed close to the surface. */
  minZoomSpeed?: number;
  dampingFactor?: number;
  /** Closest camera altitude above the reference ellipsoid, in metres. */
  minAltitude?: number;
  /** Multiplier applied to altitude-proportional wheel speed near the surface. */
  zoomAltitudeGain?: number;
  /** Right-drag surface-focus orbit sensitivity. */
  lookSpeed?: number;
  /** Middle-drag surface-tilt sensitivity. */
  tiltSpeed?: number;
};

export type GlobeEngineOptions = {
  container: HTMLElement;
  pixelRatio?: number;
  /** Caps the drawing-buffer area after DPR scaling. Defaults to 8 megapixels. */
  maxDrawingBufferPixels?: number;
  clearColor?: number;
  lod?: GlobeLodSelectorOptions;
  grid?: GlobeGridRendererOptions;
  imagery?: false | RasterTileProvider;
  raster?: RasterTileLayerOptions;
  terrain?: false | TerrainProvider;
  terrainLayer?: TerrainTileLayerOptions;
  initialView?: {
    longitude: number;
    latitude: number;
    altitude: number;
  };
  navigation?: GlobeNavigationOptions;
  onStats?: (stats: GlobeEngineStats) => void;
};

/** Stage-one globe runtime: camera + WGS84 ellipsoid + geographic quadtree grid. */
export class GlobeEngine {
  private framePerformance: GlobeFramePerformance = { lodMs: 0, terrainMs: 0, surfaceMs: 0,
    featureMs: 0, renderSubmitMs: 0, drawCalls: 0, triangles: 0, gpuMs: null, lodSelections: 0 };
  private readonly gpuTimer: GpuFrameTimer;
  private lodSelections = 0;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.02, 100_000_000);
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: GlobeCameraController;
  readonly ellipsoid = Ellipsoid.WGS84;
  readonly coordinates = new CoordinateTransform(this.ellipsoid);
  readonly lod: GlobeLodSelector;
  readonly grid: GlobeGridRenderer;
  readonly imagery: RasterTileLayer | null;
  readonly terrain: TerrainTileLayer | null;
  /** Shared per-content lifecycle registry for all raster surface layers. */
  readonly tileStateMachine = new TileStateMachine();

  private readonly container: HTMLElement;
  private readonly onStats?: (stats: GlobeEngineStats) => void;
  private frameHandle: number | null = null;
  private lastStatsSignature = '';
  private viewportWidth = 0;
  private viewportHeight = 0;
  private rendererPixelRatio = 1;
  private readonly requestedPixelRatio: number;
  private readonly maxDrawingBufferPixels: number;
  private readonly resizeObserver: ResizeObserver;
  private readonly navigation: Required<GlobeNavigationOptions>;
  private readonly terrainMaximumSurfaceDisplacement: number;
  private lodSelection: ReturnType<GlobeLodSelector['select']> | null = null;
  private lodSelectionTerrainRevision = -1;
  private lodSelectionViewportWidth = 0;
  private lodSelectionViewportHeight = 0;
  private lodSelectionMinimumLevel: number | undefined;
  private observedTerrainRevision = -1;
  private terrainRevisionRefreshAt = 0;
  private readonly lodCameraPosition = new THREE.Vector3();
  private readonly lodCameraQuaternion = new THREE.Quaternion();
  private contextLost = false;
  private readonly imageryLayers = new Map<string, RasterTileLayer>();
  private readonly featureLayers = new Map<string, GeoJsonLayer>();
  private readonly vectorLayers = new Map<string, MvtVectorLayer>();
  private readonly imageryLayerOptions: RasterTileLayerOptions;

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.gpuTimer.reset();
    for (const layer of this.imageryLayers.values()) layer.handleContextLost();
    this.terrain?.handleContextLost();
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    for (const layer of this.imageryLayers.values()) layer.handleContextRestored();
    this.terrain?.handleContextRestored();
    this.grid.handleContextRestored();
    this.lodSelection = null;
    this.lastStatsSignature = '';
  };

  constructor(options: GlobeEngineOptions) {
    this.container = options.container;
    this.requestedPixelRatio = Math.max(0.5, options.pixelRatio ?? window.devicePixelRatio);
    this.maxDrawingBufferPixels = Math.max(
      1_000_000,
      Math.round(options.maxDrawingBufferPixels ?? 8_000_000)
    );
    this.onStats = options.onStats;
    this.navigation = {
      rotateSpeed: Math.max(0.01, options.navigation?.rotateSpeed ?? 0.4),
      minRotateSpeed: Math.max(0.00000001, options.navigation?.minRotateSpeed ?? 0.000001),
      zoomSpeed: Math.max(0.01, options.navigation?.zoomSpeed ?? 0.5),
      minZoomSpeed: Math.max(0.000000001, options.navigation?.minZoomSpeed ?? 0.00000001),
      dampingFactor: THREE.MathUtils.clamp(options.navigation?.dampingFactor ?? 0.12, 0, 1),
      minAltitude: Math.max(0.05, options.navigation?.minAltitude ?? 0.25),
      zoomAltitudeGain: Math.max(0.1, options.navigation?.zoomAltitudeGain ?? 5),
      lookSpeed: Math.max(0.05, options.navigation?.lookSpeed ?? 1),
      tiltSpeed: Math.max(0.05, options.navigation?.tiltSpeed ?? 1)
    };
    const tilingScheme = options.lod?.tilingScheme ?? new WebMercatorTilingScheme();
    const terrainExaggeration = Math.max(0, options.terrainLayer?.exaggeration ?? 1);
    this.terrainMaximumSurfaceDisplacement =
      options.lod?.maximumSurfaceDisplacement ??
      (options.terrain === false || options.terrain === undefined
        ? 0
        : 12_000 * terrainExaggeration);
    this.lod = new GlobeLodSelector({
      ...options.lod,
      tilingScheme,
      maximumSurfaceDisplacement: this.terrainMaximumSurfaceDisplacement
    });
    this.terrain = options.terrain === false || options.terrain === undefined
      ? null
      : new TerrainTileLayer(this.ellipsoid, options.terrain, options.terrainLayer);
    this.lod.setSurfaceDisplacementSource(this.terrain ?? undefined);
    this.grid = new GlobeGridRenderer(this.ellipsoid, {
      ...options.grid,
      terrain: this.terrain ?? undefined
    });

    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(options.clearColor ?? 0x07131d, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.gpuTimer = new GpuFrameTimer(this.renderer.getContext() as WebGL2RenderingContext);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored, false);
    this.container.appendChild(this.renderer.domElement);
    this.imageryLayerOptions = {
      ...options.raster,
      tileStateMachine: options.raster?.tileStateMachine ?? this.tileStateMachine,
      terrain: this.terrain ?? undefined,
      maxAnisotropy:
        options.raster?.maxAnisotropy ?? this.renderer.capabilities.getMaxAnisotropy()
    };

    // This is an occlusion/fallback body, not the rendered map surface. Keep it
    // slightly below the ellipsoid so its coarse triangles can never protrude
    // through raster tiles at grazing angles near the globe limb.
    const occlusionInset = Math.min(1000, this.ellipsoid.polarRadius * 0.001);
    const occlusionEquatorialRadius = this.ellipsoid.equatorialRadius - occlusionInset;
    const occlusionPolarRadius = this.ellipsoid.polarRadius - occlusionInset;
    const globeGeometry = new THREE.SphereGeometry(occlusionEquatorialRadius, 96, 64);
    globeGeometry.scale(1, occlusionPolarRadius / occlusionEquatorialRadius, 1);
    const globeMaterial = new THREE.MeshBasicMaterial({ color: 0x17465c });
    const globe = new THREE.Mesh(globeGeometry, globeMaterial);
    globe.renderOrder = 0;
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(this.ellipsoid.equatorialRadius * 1.018, 64, 48),
      new THREE.MeshBasicMaterial({
        color: 0x52c7ff,
        transparent: true,
        opacity: 0.09,
        side: THREE.BackSide,
        depthWrite: false
      })
    );
    atmosphere.scale.y = this.ellipsoid.polarRadius / this.ellipsoid.equatorialRadius;
    atmosphere.renderOrder = 3;
    this.imagery = options.imagery === false || options.imagery === undefined
      ? null
      : new RasterTileLayer(this.ellipsoid, options.imagery, this.imageryLayerOptions);
    if (this.imagery) this.imageryLayers.set('base', this.imagery);
    this.scene.add(globe, atmosphere);
    if (this.terrain) this.scene.add(this.terrain.object3d);
    if (this.imagery) this.scene.add(this.imagery.object3d);
    this.scene.add(this.grid.object3d);

    const radius = this.ellipsoid.equatorialRadius;
    const initialView = options.initialView ?? {
      longitude: 105,
      latitude: 32,
      altitude: radius * 1.35
    };
    this.ellipsoid.cartographicToCartesian(
      {
        longitude: initialView.longitude,
        latitude: initialView.latitude,
        height: initialView.altitude
      },
      this.camera.position
    );
    this.camera.lookAt(0, 0, 0);
    this.controls = new GlobeCameraController(
      this.camera,
      this.renderer.domElement,
      this.ellipsoid,
      this.terrain ?? undefined
    );
    this.controls.enableDamping = true;
    this.controls.dampingFactor = this.navigation.dampingFactor;
    this.controls.orbitSpeed = this.navigation.rotateSpeed;
    this.controls.lookSpeed = this.navigation.lookSpeed;
    this.controls.tiltSpeed = this.navigation.tiltSpeed;
    this.controls.zoomSpeed = this.navigation.zoomSpeed;
    this.controls.minDistance = this.surfaceRadiusInDirection(this.camera.position) + this.navigation.minAltitude;
    this.controls.maxDistance = radius * 16;
    this.controls.target.set(0, 0, 0);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
  }

  start(): void {
    if (this.frameHandle !== null) return;
    const renderFrame = () => {
      this.frameHandle = requestAnimationFrame(renderFrame);
      if (this.contextLost) return;
      this.resize();
      this.updateNavigationSensitivity();
      this.controls.update();
      const cameraLevel = this.getCameraLevel();
      for (const layer of this.imageryLayers.values()) {
        if (layer.visible) layer.provider.setViewLevel?.(cameraLevel);
      }
      // Provider network/style zoom is not a minimum mesh LOD. Forcing its
      // camera zoom across the viewport defeats peripheral error reduction.
      const requestedMinimumLevelOverride = undefined;
      const terrainRevision = this.terrain?.revision ?? -1;
      const now = performance.now();
      if (terrainRevision !== this.observedTerrainRevision) {
        this.observedTerrainRevision = terrainRevision;
        // Terrain tiles often arrive in bursts. Rebuilding all LOD bounds for
        // every individual response makes marginal horizon/frustum nodes
        // alternate visibly. Batch those revisions while the camera is still.
        this.terrainRevisionRefreshAt = now + 100;
      }
      const viewportHeight = this.renderer.domElement.clientHeight;
      const viewportWidth = this.renderer.domElement.clientWidth;
      // Compare cumulative motion against the last selected pose. Exact float
      // equality makes clamp/rotation noise rebuild the entire leaf set. Keep
      // the tolerance below a small fraction of one screen pixel even near
      // the ground; slow deliberate movement eventually crosses it as well.
      const translationTolerance = Math.max(1e-4,
        this.cameraAltitude() / Math.max(1, this.focalPixels()) * 0.05);
      const rotationError = 1 - Math.min(1, Math.abs(this.camera.quaternion.dot(this.lodCameraQuaternion)));
      const cameraPoseChanged =
        this.camera.position.distanceToSquared(this.lodCameraPosition) > translationTolerance ** 2 ||
        rotationError > 1e-12;
      const terrainRefreshDue =
        terrainRevision !== this.lodSelectionTerrainRevision &&
        now >= this.terrainRevisionRefreshAt;
      const selectionChanged =
        this.lodSelection === null ||
        cameraPoseChanged ||
        viewportWidth !== this.lodSelectionViewportWidth ||
        viewportHeight !== this.lodSelectionViewportHeight ||
        requestedMinimumLevelOverride !== this.lodSelectionMinimumLevel ||
        terrainRefreshDue;
      const lodStartedAt = performance.now();
      if (selectionChanged) {
        this.lodSelections++;
        const selection = this.lod.select(
          this.camera,
          viewportHeight
        );
        this.lodSelection = selection;
        this.lodSelectionTerrainRevision = terrainRevision;
        this.lodSelectionViewportWidth = viewportWidth;
        this.lodSelectionViewportHeight = viewportHeight;
        this.lodSelectionMinimumLevel = requestedMinimumLevelOverride;
        this.lodCameraPosition.copy(this.camera.position);
        this.lodCameraQuaternion.copy(this.camera.quaternion);
      }
      const selection = this.lodSelection!;
      const terrainStartedAt = performance.now();
      const terrainStats = this.terrain?.update(selection.tiles, this.camera.position) ?? null;
      const surfaceStartedAt = performance.now();
      let imageryStats: RasterTileLayerStats | null = null;
      for (const layer of this.imageryLayers.values()) {
        if (!layer.visible) continue;
        const stats = layer.update(selection.tiles, this.camera.position);
        if (layer === this.imagery) imageryStats = stats;
      }
      const featureStartedAt = performance.now();
      for (const layer of this.featureLayers.values()) {
        if (layer.object3d.visible) layer.update(this.camera.position, now);
      }
      for (const layer of this.vectorLayers.values()) {
        if (layer.object3d.visible) {
          layer.update(selection.tiles, cameraLevel, this.camera, viewportWidth, viewportHeight);
        }
      }
      this.grid.update(selection.tiles, this.camera.position);
      const renderStartedAt = performance.now();
      this.gpuTimer.begin();
      this.renderer.render(this.scene, this.camera);
      this.gpuTimer.end();
      this.framePerformance = {
        lodMs: terrainStartedAt - lodStartedAt, terrainMs: surfaceStartedAt - terrainStartedAt,
        surfaceMs: featureStartedAt - surfaceStartedAt, featureMs: renderStartedAt - featureStartedAt,
        renderSubmitMs: performance.now() - renderStartedAt,
        drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
        gpuMs: this.gpuTimer.valueMs, lodSelections: this.lodSelections
      };
      this.emitStats(selection.stats, imageryStats, terrainStats, cameraLevel);
    };
    this.frameHandle = requestAnimationFrame(renderFrame);
  }

  stop(): void {
    if (this.frameHandle === null) return;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  dispose(): void {
    this.stop();
    this.gpuTimer.reset();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const layer of this.imageryLayers.values()) layer.dispose();
    this.imageryLayers.clear();
    for (const layer of this.featureLayers.values()) layer.dispose();
    this.featureLayers.clear();
    for (const layer of this.vectorLayers.values()) layer.dispose();
    this.vectorLayers.clear();
    this.terrain?.dispose();
    this.grid.dispose();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost, false);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored, false);
    if (!this.contextLost) this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  setImageryProvider(provider: RasterTileProvider): void {
    this.imagery?.setProvider(provider);
    this.lastStatsSignature = '';
  }

  /** Adds a raster surface layer. Annotation layers should use overlay=true. */
  addImageryLayer(
    id: string,
    provider: RasterTileProvider,
    options: RasterTileLayerOptions = {}
  ): RasterTileLayer {
    if (this.imageryLayers.has(id)) throw new Error(`Imagery layer already exists: ${id}`);
    const layer = new RasterTileLayer(this.ellipsoid, provider, {
      ...this.imageryLayerOptions,
      ...options,
      terrain: this.terrain ?? undefined,
      // Surface imagery and polygon rasters must use the exact same displaced
      // mesh as the base layer. A small physical lift is below logarithmic
      // depth precision at oblique views and produces triangle-shaped holes.
      surfaceOffset: options.surfaceOffset ?? this.imageryLayerOptions.surfaceOffset ?? 0.1
    });
    this.imageryLayers.set(id, layer);
    this.scene.add(layer.object3d);
    this.lastStatsSignature = '';
    return layer;
  }

  removeImageryLayer(id: string): boolean {
    if (id === 'base') return false;
    const layer = this.imageryLayers.get(id);
    if (!layer) return false;
    this.scene.remove(layer.object3d);
    layer.dispose();
    this.imageryLayers.delete(id);
    this.lastStatsSignature = '';
    return true;
  }

  getImageryLayer(id: string): RasterTileLayer | undefined {
    return this.imageryLayers.get(id);
  }

  addFeatureLayer(id: string, layer: GeoJsonLayer): GeoJsonLayer {
    if (this.featureLayers.has(id)) throw new Error(`Feature layer already exists: ${id}`);
    this.featureLayers.set(id, layer);
    this.scene.add(layer.object3d);
    return layer;
  }

  removeFeatureLayer(id: string): boolean {
    const layer = this.featureLayers.get(id);
    if (!layer) return false;
    this.scene.remove(layer.object3d);
    layer.dispose();
    this.featureLayers.delete(id);
    return true;
  }

  getFeatureLayer(id: string): GeoJsonLayer | undefined {
    return this.featureLayers.get(id);
  }

  addVectorLayer(id: string, layer: MvtVectorLayer): MvtVectorLayer {
    if (this.vectorLayers.has(id)) throw new Error(`Vector layer already exists: ${id}`);
    this.vectorLayers.set(id, layer);
    this.scene.add(layer.object3d);
    return layer;
  }

  removeVectorLayer(id: string): boolean {
    const layer = this.vectorLayers.get(id);
    if (!layer) return false;
    this.scene.remove(layer.object3d);
    layer.dispose();
    this.vectorLayers.delete(id);
    return true;
  }

  getVectorLayer(id: string): MvtVectorLayer | undefined {
    return this.vectorLayers.get(id);
  }

  setTerrainEnabled(enabled: boolean): void {
    this.terrain?.setEnabled(enabled);
    this.lod.setMaximumSurfaceDisplacement(
      enabled ? this.terrainMaximumSurfaceDisplacement : 0
    );
    this.lodSelection = null;
    this.lastStatsSignature = '';
  }

  flyTo(options: GlobeFlyToOptions): void {
    this.controls.flyTo(options);
  }

  getCameraViewState(): GlobeCameraViewState {
    return this.controls.getViewState();
  }

  /** Continuous camera level using the same screen-error scale as the LOD selector. */
  getCameraLevel(): number {
    const altitude = this.cameraAltitude();
    return Math.log2(
      (2 * Math.PI * this.ellipsoid.equatorialRadius * this.focalPixels()) /
      (this.lod.targetPixels * altitude)
    );
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const pixelRatio = Math.min(
      this.requestedPixelRatio,
      2,
      Math.sqrt(this.maxDrawingBufferPixels / (width * height))
    );
    if (
      width === this.viewportWidth &&
      height === this.viewportHeight &&
      Math.abs(pixelRatio - this.rendererPixelRatio) < 0.01
    ) return;
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.rendererPixelRatio = pixelRatio;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
  }

  private updateNavigationSensitivity(): void {
    const radius = this.ellipsoid.equatorialRadius;
    const cameraDistance = this.camera.position.length();
    const surfaceRadius = this.surfaceRadiusInDirection(this.camera.position);
    const terrainHeight = this.terrainHeightUnderCamera();
    const altitude = Math.max(0.001, cameraDistance - surfaceRadius - terrainHeight);
    const minimumAltitude = Math.max(
      this.navigation.minAltitude,
      this.altitudeForCameraLevel(this.lod.maxLevel)
    );
    const maximumAltitude = this.altitudeForCameraLevel(this.lod.minLevel);
    this.controls.minDistance = surfaceRadius + terrainHeight + minimumAltitude;
    this.controls.maxDistance = surfaceRadius + maximumAltitude;

    // Globe dragging derives metres-per-pixel from altitude and FOV inside the
    // controller. Keep this as a stable user sensitivity multiplier; driving
    // it towards zero made level 18+ input fall below the numeric dead zone.
    this.controls.orbitSpeed = this.navigation.rotateSpeed;

    // The globe controller already converts wheel input into a fraction of the
    // true height above terrain, so wheel feel stays stable without Earth-radius scaling.
    this.controls.zoomSpeed = this.navigation.zoomSpeed;
  }

  private cameraAltitude(): number {
    return Math.max(
      0.001,
      this.camera.position.length() - this.surfaceRadiusInDirection(this.camera.position)
        - this.terrainHeightUnderCamera()
    );
  }

  private focalPixels(): number {
    return Math.max(1, this.renderer.domElement.clientHeight) /
      (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5));
  }

  private altitudeForCameraLevel(level: number): number {
    return (2 * Math.PI * this.ellipsoid.equatorialRadius * this.focalPixels()) /
      (this.lod.targetPixels * 2 ** level);
  }

  private surfaceRadiusInDirection(direction: THREE.Vector3): number {
    const length = direction.length();
    if (length <= 0) return this.ellipsoid.equatorialRadius;
    const x = direction.x / length;
    const y = direction.y / length;
    const z = direction.z / length;
    const a = this.ellipsoid.equatorialRadius;
    const b = this.ellipsoid.polarRadius;
    return 1 / Math.sqrt((x * x + z * z) / (a * a) + (y * y) / (b * b));
  }

  private terrainHeightUnderCamera(): number {
    if (!this.terrain) return 0;
    const position = this.coordinates.worldToGeodetic(this.camera.position);
    return Math.max(0, this.terrain.sampleHeight(position.longitude, position.latitude) ?? 0);
  }

  private emitStats(
    stats: GlobeLodStats,
    imagery: RasterTileLayerStats | null,
    terrain: TerrainTileLayerStats | null,
    cameraLevel: number
  ): void {
    if (!this.onStats) return;
    const imagerySignature = imagery
      ? `${imagery.ready},${imagery.loading},${imagery.queued},${imagery.errors},${imagery.fallbacks},${imagery.textureBytes},${imagery.desiredMinimumLevel},${imagery.desiredMaximumLevel},${imagery.displayedMinimumLevel},${imagery.displayedMaximumLevel}`
      : 'none';
    const roundedCameraLevel = Math.round(cameraLevel * 10) / 10;
    const terrainSignature = terrain
      ? `${terrain.ready},${terrain.loading},${terrain.queued},${terrain.errors},${terrain.fallbacks},${terrain.resourceBytes},${terrain.stitchedEdges},${terrain.coverageReady}`
      : 'none';
    const vectorLayers = new Map(
      [...this.vectorLayers].map(([id, layer]) => [id, layer.stats] as const)
    );
    const vectorSignature = [...vectorLayers]
      .map(([id, value]) => `${id}:${value.sourceLevel},${value.ready},${value.loading},${value.queued},${value.errors},${value.visible}`)
      .join(';');
    const signature = `${Math.floor(performance.now() / 500)}|${stats.selected}|${stats.visited}|${stats.horizonCulled}|${stats.frustumCulled}|${[...stats.levels].join(';')}|${imagerySignature}|${terrainSignature}|${vectorSignature}|${roundedCameraLevel}`;
    if (signature === this.lastStatsSignature) return;
    this.lastStatsSignature = signature;
    this.onStats({ ...stats, cameraLevel: roundedCameraLevel, imagery, terrain, vectorLayers, performance: this.framePerformance });
  }
}
