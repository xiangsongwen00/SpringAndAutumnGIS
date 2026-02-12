import * as THREE from 'three';
import type { GeoCoordinator, Vec3 } from '../../geo/coords';
import type { CameraController } from '../CameraController';
import type { ToolManager } from '../ToolManager';
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
  lodGrid?: false | PlanarLodGridOptions;
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
const DEFAULT_TOP_VIEW_HEIGHT = 12_000;
const MAX_VIEWPORT_EXTENT = 20_000_000;

export class PlanarValidation {
  private readonly _renderer: THREE.WebGLRenderer;
  private readonly _camera: THREE.PerspectiveCamera;
  private readonly _cameraController: CameraController | null;
  private readonly _geo: GeoCoordinator;
  private readonly _worldRoot: THREE.Group;
  private readonly _setRenderOrigin: (threeWorld: Vec3, keepWorldCamera?: boolean) => Vec3;
  private readonly _root = new THREE.Group();
  private readonly _lodGrid: PlanarLodGrid | null;
  private readonly _mapTiles: PlanarMapTileLayer | null;
  private readonly _initialCameraHeight: number;
  private readonly _hudEnabled: boolean;

  private readonly _toolManager: ToolManager | null;
  private readonly _hudPanelId: string | null;
  private readonly _fpsPanelId: string | null;
  private readonly _onKeyDownBound: (event: KeyboardEvent) => void;
  private readonly _tmpRayPoint = new THREE.Vector3();
  private readonly _tmpRayDir = new THREE.Vector3();
  private readonly _tmpCameraDir = new THREE.Vector3();
  private readonly _tmpFocus = new THREE.Vector3();
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
    this._initialCameraHeight = options?.initialCameraHeight ?? DEFAULT_TOP_VIEW_HEIGHT;
    this._hudEnabled = options?.hud ?? true;
    this._toolManager = context.toolManager;
    this._hudPanelId = this._hudEnabled ? 'planar-validation-hud' : null;
    this._fpsPanelId = 'planar-validation-fps';
    this.setupPanels();

    this._geo.setFrontLonDeg(options?.frontLonDeg ?? 0);
    this._setRenderOrigin({ x: 0, y: 0, z: 0 }, false);

    const planeSize = options?.planeSize ?? DEFAULT_PLANE_SIZE;
    if (options?.mapTiles === false) {
      this._root.add(createBasePlane(planeSize));
    }
    this._root.add(createAxes());
    this._root.add(createDirectionArrows());

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
    }

    this._worldRoot.add(this._root);
    this.applyTopView(this._initialCameraHeight);

    this._onKeyDownBound = (event) => this.onKeyDown(event);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDownBound);
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

    const rawFocus = this._cameraController?.target ?? { x: cameraWorld.x, y: cameraWorld.y, z: 0 };
    if (this._cameraController && Math.abs(rawFocus.z) > 1e-6) {
      this._cameraController.setTarget({ x: rawFocus.x, y: rawFocus.y, z: 0 });
    }
    const focus = { x: rawFocus.x, y: rawFocus.y, z: 0 };
    const cameraHeight = Math.abs(this._camera.position.z);
    const halfHeight = cameraHeight * Math.tan((this._camera.fov * Math.PI) / 360);
    const halfWidth = halfHeight * Math.max(1, this._camera.aspect);
    const viewRadius = Math.max(halfWidth, halfHeight);
    const viewportBounds = this.computeViewportBoundsOnZ0();

    this._lodGrid?.update(focus.x, focus.y, cameraHeight);
    this._mapTiles?.update(focus.x, focus.y, cameraHeight, viewRadius, viewportBounds);

    this.updateFps();
    this.updateHud(cameraWorld);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDownBound);
    }

    this._lodGrid?.dispose();
    this._mapTiles?.dispose();
    if (this._toolManager && this._hudPanelId) this._toolManager.removePanel(this._hudPanelId);
    if (this._toolManager && this._fpsPanelId) this._toolManager.removePanel(this._fpsPanelId);
    this._worldRoot.remove(this._root);
  }

  private updateHud(cameraWorld: Vec3): void {
    if (!this._toolManager || !this._hudPanelId) return;

    const rawFocus = this._cameraController?.target ?? { x: cameraWorld.x, y: cameraWorld.y, z: 0 };
    const focus = { x: rawFocus.x, y: rawFocus.y, z: 0 };
    const cameraHeight = Math.abs(this._camera.position.z - focus.z);
    this._tmpFocus.set(focus.x, focus.y, focus.z);
    const lod = this._lodGrid?.debugInfo ?? {
      baseStep: 0,
      cameraHeight,
      focusX: focus.x,
      focusY: focus.y,
      activeSteps: []
    };
    const tile = this._mapTiles?.debugInfo;
    this._camera.getWorldDirection(this._tmpCameraDir);
    const headingDeg = normalizeDeg((Math.atan2(this._tmpCameraDir.x, this._tmpCameraDir.y) * 180) / Math.PI);
    const pitchDeg = (Math.asin(clampNumber(this._tmpCameraDir.z, -1, 1)) * 180) / Math.PI;
    const cameraDistance = this._camera.position.distanceTo(this._tmpFocus);
    const focusLonLat = this._mapTiles
      ? this._mapTiles.worldXYToLonLat(focus.x, focus.y)
      : this._geo.webMercatorToLonLat(
          focus.x * this._geo.metersPerUnit,
          focus.y * this._geo.metersPerUnit
        );

    const renderedLevelText =
      tile && tile.renderedZoomStats.length > 0
        ? tile.renderedZoomStats.map((item) => `z${item.zoom}:${item.count}`).join(',')
        : 'none';

    const tileText = tile
      ? `tileZoom=${tile.zoom} centerTile=${tile.centerX},${tile.centerY} tileRadius=${tile.tileRadius} req=${tile.requestedCount} cache=${tile.tileCount} ready=${tile.readyCount} loading=${tile.loadingCount} queued=${tile.queuedCount} error=${tile.errorCount} rendered=${tile.renderedCount} renderedByZoom=${renderedLevelText}`
      : 'tiles=disabled';
    const cameraText = `camPos=(${this._camera.position.x.toFixed(1)},${this._camera.position.y.toFixed(1)},${this._camera.position.z.toFixed(1)}) target=(${focus.x.toFixed(1)},${focus.y.toFixed(1)},${focus.z.toFixed(1)}) distance=${cameraDistance.toFixed(1)} dir=(${this._tmpCameraDir.x.toFixed(3)},${this._tmpCameraDir.y.toFixed(3)},${this._tmpCameraDir.z.toFixed(3)}) heading=${headingDeg.toFixed(1)} pitch=${pitchDeg.toFixed(1)} fov=${this._camera.fov.toFixed(1)} aspect=${this._camera.aspect.toFixed(3)} near=${this._camera.near.toFixed(2)} far=${this._camera.far.toFixed(0)}`;

    this._toolManager.setPanelLines(this._hudPanelId, [
      'XOY (z=0) planar validation',
      `focus lon=${focusLonLat.lon.toFixed(5)} lat=${focusLonLat.lat.toFixed(5)} z=0`,
      `focus=(${lod.focusX.toFixed(1)},${lod.focusY.toFixed(1)},0) cameraHeight=${lod.cameraHeight.toFixed(1)}`,
      cameraText,
      this._lodGrid
        ? `baseStep=${lod.baseStep} activeSteps=${lod.activeSteps.join('/')}`
        : 'lodGrid=disabled',
      tileText,
      '+X east | +Y north | T top-view | R reset'
    ]);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (key === 't') {
      this.applyTopView(Math.max(4_000, Math.abs(this._camera.position.z)));
      return;
    }
    if (key !== 'r') return;

    const resetTarget = { x: 0, y: 0, z: 0 };
    this._cameraController?.setTarget(resetTarget);
    this.applyTopView(this._initialCameraHeight);
  }

  private applyTopView(height: number): void {
    const target = this._cameraController?.target ?? { x: 0, y: 0, z: 0 };
    const nextTarget = { x: target.x, y: target.y, z: 0 };
    this._cameraController?.setTarget(nextTarget);
    this._camera.position.set(nextTarget.x, nextTarget.y, Math.max(height, 1));
    this._camera.lookAt(nextTarget.x, nextTarget.y, nextTarget.z);
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
  const axes = new THREE.AxesHelper(10_000);
  axes.renderOrder = 20;
  return axes;
}

function createDirectionArrows(): THREE.Group {
  const group = new THREE.Group();

  const eastArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 0),
    3_000,
    0xff4d4f,
    240,
    120
  );
  const northArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 0),
    3_000,
    0x22c55e,
    240,
    120
  );

  eastArrow.renderOrder = 21;
  northArrow.renderOrder = 21;
  group.add(eastArrow, northArrow);
  return group;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeDeg(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
