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
import {
  GlobeCameraController,
  type GlobeCameraViewState,
  type GlobeFlyToOptions
} from './GlobeCameraController';

export type GlobeEngineStats = GlobeLodStats & Readonly<{
  cameraLevel: number;
  imagery: RasterTileLayerStats | null;
  terrain: TerrainTileLayerStats | null;
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

  private readonly container: HTMLElement;
  private readonly onStats?: (stats: GlobeEngineStats) => void;
  private frameHandle: number | null = null;
  private lastStatsSignature = '';
  private viewportWidth = 0;
  private viewportHeight = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly navigation: Required<GlobeNavigationOptions>;

  constructor(options: GlobeEngineOptions) {
    this.container = options.container;
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
    this.lod = new GlobeLodSelector({ ...options.lod, tilingScheme });
    this.terrain = options.terrain === false || options.terrain === undefined
      ? null
      : new TerrainTileLayer(this.ellipsoid, options.terrain, options.terrainLayer);
    this.grid = new GlobeGridRenderer(this.ellipsoid, {
      ...options.grid,
      terrain: this.terrain ?? undefined
    });

    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(options.pixelRatio ?? window.devicePixelRatio, 2));
    this.renderer.setClearColor(options.clearColor ?? 0x07131d, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

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
      : new RasterTileLayer(this.ellipsoid, options.imagery, {
          ...options.raster,
          terrain: this.terrain ?? undefined,
          maxAnisotropy:
            options.raster?.maxAnisotropy ?? this.renderer.capabilities.getMaxAnisotropy()
        });
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
    this.controls.minDistance = radius + this.navigation.minAltitude;
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
      this.resize();
      this.updateNavigationSensitivity();
      this.controls.update();
      const cameraLevel = this.getCameraLevel();
      this.imagery?.provider.setViewLevel?.(cameraLevel);
      const minimumLodLevelOffset = this.imagery?.provider.minimumLodLevelOffset;
      const surfacePitch = this.controls.getViewState().pitch;
      const useMinimumLevelOverride =
        minimumLodLevelOffset !== undefined &&
        surfacePitch !== null &&
        surfacePitch <= -55;
      let minimumLevelOverride = !useMinimumLevelOverride
        ? undefined
        : Math.floor(cameraLevel) + minimumLodLevelOffset!;
      let selection = this.lod.select(
        this.camera,
        this.renderer.domElement.clientHeight,
        minimumLevelOverride
      );
      // A forced vector minimum can exceed the tile budget at polar/oblique
      // global views. Never keep a half-refined mix spanning several levels:
      // lower the whole minimum and select again until refinement completes.
      while (
        minimumLevelOverride !== undefined &&
        minimumLevelOverride > this.lod.minLevel &&
        selection.tiles.length >= this.lod.maxTiles &&
        minimumSelectedLevel(selection.stats) < minimumLevelOverride
      ) {
        minimumLevelOverride -= 1;
        selection = this.lod.select(
          this.camera,
          this.renderer.domElement.clientHeight,
          minimumLevelOverride
        );
      }
      const terrainStats = this.terrain?.update(selection.tiles, this.camera.position) ?? null;
      const imageryStats = this.imagery?.update(selection.tiles, this.camera.position) ?? null;
      this.grid.update(selection.tiles, this.camera.position);
      this.emitStats(selection.stats, imageryStats, terrainStats, cameraLevel);
      this.renderer.render(this.scene, this.camera);
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
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.imagery?.dispose();
    this.terrain?.dispose();
    this.grid.dispose();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  setImageryProvider(provider: RasterTileProvider): void {
    this.imagery?.setProvider(provider);
    this.lastStatsSignature = '';
  }

  setTerrainEnabled(enabled: boolean): void {
    this.terrain?.setEnabled(enabled);
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
    if (width === this.viewportWidth && height === this.viewportHeight) return;
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private updateNavigationSensitivity(): void {
    const radius = this.ellipsoid.equatorialRadius;
    const cameraDistance = this.camera.position.length();
    const surfaceRadius = this.surfaceRadiusInDirection(this.camera.position);
    const terrainHeight = this.terrainHeightUnderCamera();
    const altitude = Math.max(0.001, cameraDistance - surfaceRadius - terrainHeight);
    const altitudeRatio = THREE.MathUtils.clamp(altitude / radius, 0, 1);
    const minimumAltitude = Math.max(
      this.navigation.minAltitude,
      this.altitudeForCameraLevel(this.lod.maxLevel)
    );
    const maximumAltitude = this.altitudeForCameraLevel(this.lod.minLevel);
    this.controls.minDistance = surfaceRadius + terrainHeight + minimumAltitude;
    this.controls.maxDistance = surfaceRadius + maximumAltitude;

    // A near-linear curve is deliberately slower than sqrt(altitude) at local scale.
    this.controls.orbitSpeed = THREE.MathUtils.lerp(
      this.navigation.minRotateSpeed,
      this.navigation.rotateSpeed,
      altitudeRatio ** 0.82
    );

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
      ? `${imagery.ready},${imagery.loading},${imagery.queued},${imagery.errors},${imagery.fallbacks}`
      : 'none';
    const roundedCameraLevel = Math.round(cameraLevel * 10) / 10;
    const terrainSignature = terrain
      ? `${terrain.ready},${terrain.loading},${terrain.queued},${terrain.errors},${terrain.fallbacks}`
      : 'none';
    const signature = `${stats.selected}|${stats.visited}|${stats.horizonCulled}|${stats.frustumCulled}|${[...stats.levels].join(';')}|${imagerySignature}|${terrainSignature}|${roundedCameraLevel}`;
    if (signature === this.lastStatsSignature) return;
    this.lastStatsSignature = signature;
    this.onStats({ ...stats, cameraLevel: roundedCameraLevel, imagery, terrain });
  }
}

function minimumSelectedLevel(stats: GlobeLodStats): number {
  const levels = [...stats.levels.keys()];
  return levels.length > 0 ? Math.min(...levels) : Number.POSITIVE_INFINITY;
}
