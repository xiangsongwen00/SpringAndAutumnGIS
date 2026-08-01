import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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

export type GlobeEngineStats = GlobeLodStats & Readonly<{
  imagery: RasterTileLayerStats | null;
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
};

export type GlobeEngineOptions = {
  container: HTMLElement;
  pixelRatio?: number;
  clearColor?: number;
  lod?: GlobeLodSelectorOptions;
  grid?: GlobeGridRendererOptions;
  imagery?: false | RasterTileProvider;
  raster?: RasterTileLayerOptions;
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
  readonly camera = new THREE.PerspectiveCamera(50, 1, 10, 100_000_000);
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly ellipsoid = Ellipsoid.WGS84;
  readonly lod: GlobeLodSelector;
  readonly grid: GlobeGridRenderer;
  readonly imagery: RasterTileLayer | null;

  private readonly container: HTMLElement;
  private readonly onStats?: (stats: GlobeEngineStats) => void;
  private frameHandle: number | null = null;
  private lastStatsSignature = '';
  private readonly resizeObserver: ResizeObserver;
  private readonly navigation: Required<GlobeNavigationOptions>;

  constructor(options: GlobeEngineOptions) {
    this.container = options.container;
    this.onStats = options.onStats;
    this.navigation = {
      rotateSpeed: Math.max(0.01, options.navigation?.rotateSpeed ?? 0.4),
      minRotateSpeed: Math.max(0.001, options.navigation?.minRotateSpeed ?? 0.006),
      zoomSpeed: Math.max(0.01, options.navigation?.zoomSpeed ?? 0.5),
      minZoomSpeed: Math.max(0.00005, options.navigation?.minZoomSpeed ?? 0.0002),
      dampingFactor: THREE.MathUtils.clamp(options.navigation?.dampingFactor ?? 0.12, 0, 1),
      minAltitude: Math.max(50, options.navigation?.minAltitude ?? 250),
      zoomAltitudeGain: Math.max(0.1, options.navigation?.zoomAltitudeGain ?? 5)
    };
    const tilingScheme = options.lod?.tilingScheme ?? new WebMercatorTilingScheme();
    this.lod = new GlobeLodSelector({ ...options.lod, tilingScheme });
    this.grid = new GlobeGridRenderer(this.ellipsoid, options.grid);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(options.pixelRatio ?? window.devicePixelRatio, 2));
    this.renderer.setClearColor(options.clearColor ?? 0x07131d, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    const globeGeometry = new THREE.SphereGeometry(this.ellipsoid.equatorialRadius, 96, 64);
    globeGeometry.scale(1, this.ellipsoid.polarRadius / this.ellipsoid.equatorialRadius, 1);
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
          maxAnisotropy:
            options.raster?.maxAnisotropy ?? this.renderer.capabilities.getMaxAnisotropy()
        });
    this.scene.add(globe, atmosphere);
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
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = this.navigation.dampingFactor;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = this.navigation.rotateSpeed;
    this.controls.zoomSpeed = this.navigation.zoomSpeed;
    this.controls.minDistance = radius + this.navigation.minAltitude;
    this.controls.maxDistance = radius * 8;
    this.controls.minPolarAngle = 0.015;
    this.controls.maxPolarAngle = Math.PI - 0.015;
    this.controls.target.set(0, 0, 0);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
  }

  start(): void {
    if (this.frameHandle !== null) return;
    const renderFrame = () => {
      this.frameHandle = requestAnimationFrame(renderFrame);
      this.updateNavigationSensitivity();
      this.controls.update();
      const selection = this.lod.select(this.camera, this.renderer.domElement.clientHeight);
      const imageryStats = this.imagery?.update(selection.tiles) ?? null;
      this.grid.update(selection.tiles);
      this.emitStats(selection.stats, imageryStats);
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

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private updateNavigationSensitivity(): void {
    const radius = this.ellipsoid.equatorialRadius;
    const cameraDistance = this.camera.position.length();
    const surfaceRadius = this.surfaceRadiusInDirection(this.camera.position);
    const altitude = Math.max(0, cameraDistance - surfaceRadius);
    const altitudeRatio = THREE.MathUtils.clamp(altitude / radius, 0, 1);
    this.controls.minDistance = surfaceRadius + this.navigation.minAltitude;

    // A near-linear curve is deliberately slower than sqrt(altitude) at local scale.
    this.controls.rotateSpeed = THREE.MathUtils.lerp(
      this.navigation.minRotateSpeed,
      this.navigation.rotateSpeed,
      altitudeRatio ** 0.82
    );

    // OrbitControls zooms relative to distance from the origin. Scaling its
    // speed linearly with altitude makes a wheel step approximately proportional
    // to height above terrain instead of proportional to the Earth radius.
    this.controls.zoomSpeed = THREE.MathUtils.clamp(
      this.navigation.zoomSpeed * altitudeRatio * this.navigation.zoomAltitudeGain,
      this.navigation.minZoomSpeed,
      this.navigation.zoomSpeed
    );
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

  private emitStats(stats: GlobeLodStats, imagery: RasterTileLayerStats | null): void {
    if (!this.onStats) return;
    const imagerySignature = imagery
      ? `${imagery.ready},${imagery.loading},${imagery.queued},${imagery.errors},${imagery.fallbacks}`
      : 'none';
    const signature = `${stats.selected}|${stats.visited}|${stats.horizonCulled}|${stats.frustumCulled}|${[...stats.levels].join(';')}|${imagerySignature}`;
    if (signature === this.lastStatsSignature) return;
    this.lastStatsSignature = signature;
    this.onStats({ ...stats, imagery });
  }
}

