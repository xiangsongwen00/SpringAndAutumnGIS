import * as THREE from 'three';
import type { GeoCoordinator, Vec3 } from '../../geo/coords';
import type { CameraController } from '../CameraController';
import type { ToolManager } from '../ToolManager';
import { TerrainLayer, type TerrainLayerOptions } from '../terrain/TerrainLayer';
import { PlanarLodGrid, type PlanarLodGridOptions } from './PlanarLodGrid';
import {
  PlanarMapTileLayer,
  type PlanarMapTileLayerOptions,
  type ViewportWorldBounds
} from './PlanarMapTileLayer';

export type PlanarValidationOptions = {
  frontLonDeg?: number;
  initialCameraHeight?: number;
  planeSize?: number;
  hud?: boolean;
  lockCameraTargetToGlobeCenter?: boolean;
  lodGrid?: false | PlanarLodGridOptions;
  terrain?: false | TerrainLayerOptions;
  mapTiles?: false | PlanarMapTileLayerOptions;
};

type PlanarValidationContext = {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  cameraController: CameraController | null;
  toolManager: ToolManager | null;
  geo: GeoCoordinator;
  worldRoot: THREE.Group;
  setRenderOrigin: (threeWorld: Vec3, keepWorldCamera?: boolean) => Vec3;
};

const DEFAULT_PLANE_SIZE = 240_000;
const DEFAULT_VIEW_DISTANCE = 2_800_000;
const MAX_VIEWPORT_EXTENT = 20_000_000;
const MIN_CAMERA_ALTITUDE_METERS = 2_000;
const GLOBE_BASE_RADIUS_OFFSET_METERS = 15_000;

export class PlanarValidation {
  private readonly _renderer: THREE.WebGLRenderer;
  private readonly _camera: THREE.PerspectiveCamera;
  private readonly _cameraController: CameraController | null;
  private readonly _geo: GeoCoordinator;
  private readonly _worldRoot: THREE.Group;
  private readonly _setRenderOrigin: (threeWorld: Vec3, keepWorldCamera?: boolean) => Vec3;
  private readonly _root = new THREE.Group();
  private readonly _globeProxy: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhongMaterial>;
  private readonly _lodGrid: PlanarLodGrid | null;
  private readonly _terrain: TerrainLayer | null;
  private readonly _mapTiles: PlanarMapTileLayer | null;
  private readonly _initialCameraHeight: number;
  private readonly _earthRadius: number;
  private readonly _globeRadius: number;
  private readonly _hudEnabled: boolean;
  private readonly _lockCameraTargetToGlobeCenter: boolean;

  private readonly _toolManager: ToolManager | null;
  private readonly _hudPanelId: string | null;
  private readonly _fpsPanelId: string | null;
  private readonly _onKeyDownBound: (event: KeyboardEvent) => void;
  private readonly _onTerrainToggleBound: (event: Event) => void;
  private readonly _tmpRayPoint = new THREE.Vector3();
  private readonly _tmpRayDir = new THREE.Vector3();
  private readonly _tmpCameraDir = new THREE.Vector3();
  private readonly _tmpFocus = new THREE.Vector3();
  private readonly _tmpFallbackDir = new THREE.Vector3();
  private readonly _focusLonLat = { lon: 0, lat: 0 };
  private _lastFpsSampleMs = 0;
  private _fpsFrames = 0;
  private _fps = 0;
  private _disposed = false;

  constructor(context: PlanarValidationContext, options?: PlanarValidationOptions) {
    this._renderer = context.renderer;
    this._camera = context.camera;
    this._cameraController = context.cameraController;
    this._geo = context.geo;
    this._worldRoot = context.worldRoot;
    this._setRenderOrigin = context.setRenderOrigin;
    this._initialCameraHeight = options?.initialCameraHeight ?? DEFAULT_VIEW_DISTANCE;
    this._earthRadius = this._geo.earthRadiusInThreeUnits();
    this._globeRadius = Math.max(
      1,
      this._earthRadius - GLOBE_BASE_RADIUS_OFFSET_METERS / this._geo.metersPerUnit
    );
    this._hudEnabled = options?.hud ?? true;
    this._lockCameraTargetToGlobeCenter = options?.lockCameraTargetToGlobeCenter ?? true;
    if (this._cameraController && this._lockCameraTargetToGlobeCenter) {
      this._cameraController.lockTarget = true;
      this._cameraController.minDistance =
        this._globeRadius + MIN_CAMERA_ALTITUDE_METERS / this._geo.metersPerUnit;
      this._cameraController.maxDistance = Math.max(this._cameraController.maxDistance, this._globeRadius * 12);
    }
    this._toolManager = context.toolManager;
    this._hudPanelId = this._hudEnabled ? 'planar-validation-hud' : null;
    this._fpsPanelId = 'planar-validation-fps';
    this.setupPanels();

    this._geo.setFrontLonDeg(options?.frontLonDeg ?? 0);
    this._setRenderOrigin({ x: 0, y: 0, z: 0 }, false);
    this._globeProxy = createGlobeProxy(this._globeRadius);
    this._root.add(this._globeProxy);

    const planeSize = options?.planeSize ?? DEFAULT_PLANE_SIZE;
    if (options?.terrain === false && options?.mapTiles === false) {
      this._root.add(createBasePlane(planeSize));
    }
    this._root.add(createAxes());
    this._root.add(createDirectionArrows());

    const terrainOptions: TerrainLayerOptions | undefined =
      options?.terrain === false ? undefined : options?.terrain;
    this._terrain = options?.terrain === false ? null : new TerrainLayer(this._geo, terrainOptions);
    if (this._terrain) {
      this._root.add(this._terrain.object3d);
      this._terrain.setEnabled(true);
    }

    this._lodGrid = options?.lodGrid === false ? null : new PlanarLodGrid(options?.lodGrid);
    if (this._lodGrid) {
      this._root.add(this._lodGrid.object3d);
    }

    const anisotropy = Math.max(1, Math.min(8, this._renderer.capabilities.getMaxAnisotropy()));
    this._mapTiles =
      options?.mapTiles === false
        ? null
        : new PlanarMapTileLayer(this._geo, {
            maxAnisotropy: anisotropy,
            ...(options?.mapTiles ?? {})
          });
    if (this._mapTiles) {
      this._root.add(this._mapTiles.object3d);
      this._mapTiles.setEnabled(false);
    }

    this._worldRoot.add(this._root);
    this.applyInitial3DView(this._initialCameraHeight);

    this._onKeyDownBound = (event) => this.onKeyDown(event);
    this._onTerrainToggleBound = (event) => this.onTerrainToggle(event);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDownBound);
    }
    if (typeof document !== 'undefined') {
      document.body.addEventListener('sag:terrain-toggle', this._onTerrainToggleBound);
    }
  }

  private setupPanels(): void {
    if (!this._toolManager || typeof document === 'undefined') return;

    if (this._hudPanelId) {
      this._toolManager.removePanel(this._hudPanelId);
      const existingHud = document.querySelector('.hud') as HTMLElement | null;
      const hudOptions = {
        placement: { top: '12px', left: '12px' },
        style: { maxWidth: '60vw', whiteSpace: 'pre' as const },
        visible: true
      };
      if (existingHud) {
        this._toolManager.attachPanel(this._hudPanelId, existingHud, hudOptions);
      } else {
        this._toolManager.createPanel(this._hudPanelId, {
          className: 'hud',
          ...hudOptions
        });
      }
    }

    if (this._fpsPanelId) {
      this._toolManager.removePanel(this._fpsPanelId);
      this._toolManager.createPanel(this._fpsPanelId, {
        className: 'sag-fps',
        placement: { top: '12px', right: '12px' },
        style: { maxWidth: '200px', whiteSpace: 'normal' },
        visible: true
      });
      this._toolManager.setPanelText(this._fpsPanelId, 'FPS --.-');
    }
  }

  update(cameraWorld: Vec3): void {
    if (this._disposed) return;

    this.lockCameraTargetToGlobeCenter();
    this.enforceCameraOutsideGlobe();
    const focus = this.resolveFocusOnGlobe(cameraWorld);
    const cameraDistance = this._camera.position.distanceTo(focus);
    const cameraAltitude = this.getCameraAltitudeToGlobe();
    this._tmpFocus.copy(focus);
    const focusWgs84 = this._geo.threeToWgs84({ x: focus.x, y: focus.y, z: focus.z });
    this._focusLonLat.lon = focusWgs84.lon;
    this._focusLonLat.lat = focusWgs84.lat;

    const halfHeight = cameraDistance * Math.tan((this._camera.fov * Math.PI) / 360);
    const halfWidth = halfHeight * Math.max(1, this._camera.aspect);
    const viewRadius = Math.max(halfWidth, halfHeight);
    const mapEnabled = this._mapTiles?.enabled ?? false;
    const viewportBounds = mapEnabled ? this.computeViewportBoundsOnZ0() : null;

    this._lodGrid?.update(focus.x, focus.y, cameraAltitude);
    this._terrain?.update(this._focusLonLat.lon, this._focusLonLat.lat, cameraAltitude);
    this._mapTiles?.update(focus.x, focus.y, cameraDistance, viewRadius, viewportBounds);

    this.updateFps();
    this.updateHud(cameraWorld);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDownBound);
    }
    if (typeof document !== 'undefined') {
      document.body.removeEventListener('sag:terrain-toggle', this._onTerrainToggleBound);
    }

    this._lodGrid?.dispose();
    this._terrain?.dispose();
    this._mapTiles?.dispose();
    if (this._toolManager && this._hudPanelId) this._toolManager.removePanel(this._hudPanelId);
    if (this._toolManager && this._fpsPanelId) this._toolManager.removePanel(this._fpsPanelId);
    this._worldRoot.remove(this._root);
  }

  private updateHud(cameraWorld: Vec3): void {
    if (!this._toolManager || !this._hudPanelId) return;

    if (this._tmpFocus.lengthSq() <= 0) {
      this._tmpFocus.copy(this.resolveFocusOnGlobe(cameraWorld));
    }
    const focus = { x: this._tmpFocus.x, y: this._tmpFocus.y, z: this._tmpFocus.z };
    const cameraDistance = this._camera.position.distanceTo(this._tmpFocus);
    const cameraAltitude = this.getCameraAltitudeToGlobe();
    const lod = this._lodGrid?.debugInfo ?? {
      baseStep: 0,
      cameraHeight: cameraAltitude,
      focusX: focus.x,
      focusY: focus.y,
      activeSteps: []
    };
    const terrain = this._terrain?.debugInfo;
    const tile = this._mapTiles?.debugInfo;
    this._camera.getWorldDirection(this._tmpCameraDir);
    const headingDeg = normalizeDeg((Math.atan2(this._tmpCameraDir.x, this._tmpCameraDir.y) * 180) / Math.PI);
    const pitchDeg = (Math.asin(clampNumber(this._tmpCameraDir.z, -1, 1)) * 180) / Math.PI;
    const focusLonLat = this._focusLonLat;

    const renderedLevelText =
      tile && tile.renderedZoomStats.length > 0
        ? tile.renderedZoomStats.map((item) => `z${item.zoom}:${item.count}`).join(',')
        : 'none';

    const terrainText = terrain
      ? `terrainZoom=${terrain.zoom} centerTile=${terrain.centerX},${terrain.centerY} radius=${terrain.tileRadius} cache=${terrain.tileCount} ready=${terrain.readyCount} loading=${terrain.loadingCount} queued=${terrain.queuedCount} error=${terrain.errorCount}`
      : 'terrain=disabled';
    const tileText =
      tile && tile.enabled
        ? `mapZoom=${tile.zoom} centerTile=${tile.centerX},${tile.centerY} radius=${tile.tileRadius} req=${tile.requestedCount} cache=${tile.tileCount} ready=${tile.readyCount} loading=${tile.loadingCount} queued=${tile.queuedCount} error=${tile.errorCount} rendered=${tile.renderedCount} renderedByZoom=${renderedLevelText}`
        : 'mapTiles=disabled';
    const cameraText = `camPos=(${this._camera.position.x.toFixed(1)},${this._camera.position.y.toFixed(1)},${this._camera.position.z.toFixed(1)}) target=(${focus.x.toFixed(1)},${focus.y.toFixed(1)},${focus.z.toFixed(1)}) altitude=${cameraAltitude.toFixed(1)} rayDistance=${cameraDistance.toFixed(1)} dir=(${this._tmpCameraDir.x.toFixed(3)},${this._tmpCameraDir.y.toFixed(3)},${this._tmpCameraDir.z.toFixed(3)}) heading=${headingDeg.toFixed(1)} pitch=${pitchDeg.toFixed(1)} fov=${this._camera.fov.toFixed(1)} aspect=${this._camera.aspect.toFixed(3)} near=${this._camera.near.toFixed(2)} far=${this._camera.far.toFixed(0)}`;

    this._toolManager.setPanelLines(this._hudPanelId, [
      '3D terrain mode',
      `focus lon=${focusLonLat.lon.toFixed(5)} lat=${focusLonLat.lat.toFixed(5)} z=${focus.z.toFixed(1)}`,
      `focus=(${lod.focusX.toFixed(1)},${lod.focusY.toFixed(1)},${focus.z.toFixed(1)}) cameraAltitude=${lod.cameraHeight.toFixed(1)}`,
      cameraText,
      this._lodGrid
        ? `baseStep=${lod.baseStep} activeSteps=${lod.activeSteps.join('/')}`
        : 'lodGrid=disabled',
      terrainText,
      tileText,
      '+X east | +Y north | R reset'
    ]);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (key !== 'r') return;

    this.applyInitial3DView(this._initialCameraHeight);
  }

  private onTerrainToggle(_event: Event): void {
    if (!this._terrain) return;
    this._terrain.setEnabled(true);
    if (this._mapTiles) {
      this._mapTiles.setEnabled(false);
    }
  }

  private applyInitial3DView(distance: number): void {
    const d = Math.max(distance, 1000);
    const target = this._geo.wgs84ToThree(0, this._geo.frontLonDeg, 0);
    const targetVec = new THREE.Vector3(target.x, target.y, target.z).normalize();
    const eastSample = this._geo.wgs84ToThree(0, this._geo.frontLonDeg + 0.1, 0);
    const northSample = this._geo.wgs84ToThree(0.1, this._geo.frontLonDeg, 0);
    const east = new THREE.Vector3(
      eastSample.x - target.x,
      eastSample.y - target.y,
      eastSample.z - target.z
    ).normalize();
    const north = new THREE.Vector3(
      northSample.x - target.x,
      northSample.y - target.y,
      northSample.z - target.z
    ).normalize();
    const cam = new THREE.Vector3(target.x, target.y, target.z)
      .addScaledVector(targetVec, d)
      .addScaledVector(east, d * 0.25)
      .addScaledVector(north, d * 0.18);

    this._cameraController?.setTarget({ x: 0, y: 0, z: 0 });
    this._camera.position.copy(cam);
    this._camera.lookAt(0, 0, 0);
    this._tmpFocus.set(target.x, target.y, target.z);
    this._focusLonLat.lon = this._geo.frontLonDeg;
    this._focusLonLat.lat = 0;
  }

  private lockCameraTargetToGlobeCenter(): void {
    if (!this._lockCameraTargetToGlobeCenter) return;
    this._cameraController?.setTarget({ x: 0, y: 0, z: 0 });
  }

  private enforceCameraOutsideGlobe(): void {
    const minRadius = this._globeRadius + MIN_CAMERA_ALTITUDE_METERS / this._geo.metersPerUnit;
    const minRadiusSq = minRadius * minRadius;
    const cam = this._camera.position;
    const lenSq = cam.lengthSq();
    if (lenSq >= minRadiusSq) return;

    if (lenSq <= 1e-8) {
      cam.set(0, minRadius, 0);
    } else {
      cam.multiplyScalar(minRadius / Math.sqrt(lenSq));
    }
  }

  private getCameraAltitudeToGlobe(): number {
    const radiusFromCenter = this._camera.position.length();
    return Math.max(0, radiusFromCenter - this._globeRadius);
  }

  private resolveFocusOnGlobe(cameraWorld: Vec3): THREE.Vector3 {
    const rayOrigin = this._camera.position;

    if (this._cameraController) {
      const target = this._cameraController.target;
      this._tmpRayDir.set(target.x - rayOrigin.x, target.y - rayOrigin.y, target.z - rayOrigin.z);
      if (this._tmpRayDir.lengthSq() < 1e-6) {
        this._camera.getWorldDirection(this._tmpRayDir);
      }
    } else {
      this._camera.getWorldDirection(this._tmpRayDir);
    }
    this._tmpRayDir.normalize();

    const hit = intersectRaySphere(rayOrigin, this._tmpRayDir, this._globeRadius);
    if (hit) {
      return hit;
    }

    this._tmpFallbackDir.set(cameraWorld.x, cameraWorld.y, cameraWorld.z);
    if (this._tmpFallbackDir.lengthSq() < 1e-6) {
      this._tmpFallbackDir.set(0, this._globeRadius, 0);
    } else {
      this._tmpFallbackDir.setLength(this._globeRadius);
    }
    return this._tmpFallbackDir.clone();
  }

  private computeViewportBoundsOnZ0(): ViewportWorldBounds | null {
    const corners: readonly [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1]
    ];

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const origin = this._camera.position;

    for (const [nx, ny] of corners) {
      this._tmpRayPoint.set(nx, ny, 0.5).unproject(this._camera);
      this._tmpRayDir.copy(this._tmpRayPoint).sub(origin);
      if (Math.abs(this._tmpRayDir.z) < 1e-6) {
        return null;
      }

      const t = -origin.z / this._tmpRayDir.z;
      if (!Number.isFinite(t) || t <= 0) {
        return null;
      }

      const ix = origin.x + this._tmpRayDir.x * t;
      const iy = origin.y + this._tmpRayDir.y * t;
      if (!Number.isFinite(ix) || !Number.isFinite(iy)) {
        return null;
      }

      minX = Math.min(minX, ix);
      minY = Math.min(minY, iy);
      maxX = Math.max(maxX, ix);
      maxY = Math.max(maxY, iy);
    }

    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    ) {
      return null;
    }

    if (maxX - minX > MAX_VIEWPORT_EXTENT || maxY - minY > MAX_VIEWPORT_EXTENT) {
      return null;
    }

    return { minX, minY, maxX, maxY };
  }

  private updateFps(): void {
    if (!this._toolManager || !this._fpsPanelId) return;

    const now = performance.now();
    if (this._lastFpsSampleMs <= 0) {
      this._lastFpsSampleMs = now;
      this._fpsFrames = 0;
      return;
    }

    this._fpsFrames += 1;
    const elapsedMs = now - this._lastFpsSampleMs;
    if (elapsedMs < 250) return;

    const instantFps = (this._fpsFrames * 1000) / Math.max(elapsedMs, 1);
    this._fps = this._fps <= 0 ? instantFps : this._fps * 0.7 + instantFps * 0.3;
    this._fpsFrames = 0;
    this._lastFpsSampleMs = now;

    const fps = this._fps;
    const color = fps < 30 ? '#ef4444' : fps < 50 ? '#facc15' : '#22c55e';
    this._toolManager.setPanelText(this._fpsPanelId, `FPS ${fps.toFixed(1)}`);
    this._toolManager.setPanelTextColor(this._fpsPanelId, color);
  }
}

function createBasePlane(size: number): THREE.Mesh {
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      color: 0x101828,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false
    })
  );
  plane.position.set(0, 0, -0.8);
  plane.renderOrder = 0;
  return plane;
}

function createAxes(): THREE.AxesHelper {
  const axes = new THREE.AxesHelper(1_500_000);
  axes.renderOrder = 20;
  return axes;
}

function createDirectionArrows(): THREE.Group {
  const group = new THREE.Group();

  const eastArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 0),
    250_000,
    0xff4d4f,
    12_000,
    8_000
  );
  const northArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 0),
    250_000,
    0x22c55e,
    12_000,
    8_000
  );

  eastArrow.renderOrder = 21;
  northArrow.renderOrder = 21;
  group.add(eastArrow, northArrow);
  return group;
}

function createGlobeProxy(radius: number): THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhongMaterial> {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 192, 128),
    new THREE.MeshPhongMaterial({
      color: 0x1e40af,
      emissive: 0x0a1a44,
      shininess: 20,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    })
  );
  mesh.visible = true;
  mesh.renderOrder = -10;
  return mesh;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeDeg(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function intersectRaySphere(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  radius: number
): THREE.Vector3 | null {
  const b = origin.dot(direction);
  const c = origin.lengthSq() - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const t0 = -b - sqrtDisc;
  const t1 = -b + sqrtDisc;
  const t = t0 > 1e-6 ? t0 : t1 > 1e-6 ? t1 : -1;
  if (t <= 0) return null;

  return origin.clone().addScaledVector(direction, t);
}
