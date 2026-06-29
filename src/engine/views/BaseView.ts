import * as THREE from 'three';
import type { GeoCoordinator } from '../../geo/coords';
import type { CameraController } from '../CameraController';
import type { LayerManager } from '../layers/LayerManager';

export type ViewMode = '2d' | '3d';

export type ViewState = {
  centerLon: number;
  centerLat: number;
  height: number;
  zoom: number;
  heading: number;
  pitch: number;
  roll: number;
};

export type ViewStateInput = Partial<ViewState>;

export const DEFAULT_VIEW_STATE: ViewState = {
  centerLon: 0,
  centerLat: 0,
  height: 2_800_000,
  zoom: 3,
  heading: 0,
  pitch: -45,
  roll: 0
};

export function normalizeViewState(input?: ViewStateInput): ViewState {
  const merged = {
    ...DEFAULT_VIEW_STATE,
    ...(input ?? {})
  };

  return {
    centerLon: normalizeLon(merged.centerLon),
    centerLat: clamp(merged.centerLat, -85.05112878, 85.05112878),
    height: Math.max(0, finiteOrDefault(merged.height, DEFAULT_VIEW_STATE.height)),
    zoom: clamp(finiteOrDefault(merged.zoom, DEFAULT_VIEW_STATE.zoom), 0, 24),
    heading: normalizeAngle(merged.heading),
    pitch: clamp(finiteOrDefault(merged.pitch, DEFAULT_VIEW_STATE.pitch), -90, 90),
    roll: normalizeAngle(merged.roll)
  };
}

export function mergeViewState(current: ViewState, patch: ViewStateInput): ViewState {
  return normalizeViewState({
    ...current,
    ...patch
  });
}

export function heightToZoom(heightMeters: number): number {
  const h = Math.max(1, finiteOrDefault(heightMeters, DEFAULT_VIEW_STATE.height));
  const zoom = Math.log2(40_075_016.68557849 / Math.max(1, h)) - 1;
  return clamp(zoom, 0, 24);
}

export function zoomToHeight(zoom: number): number {
  const z = clamp(finiteOrDefault(zoom, DEFAULT_VIEW_STATE.zoom), 0, 24);
  return 40_075_016.68557849 / 2 ** (z + 1);
}

export type ViewContext = {
  scene: THREE.Scene;
  worldRoot: THREE.Group;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  geo: GeoCoordinator;
  layers: LayerManager;
  cameraController: CameraController | null;
};

export abstract class BaseView {
  readonly mode: ViewMode;
  protected readonly context: ViewContext;
  protected readonly root = new THREE.Group();
  private _active = false;

  protected constructor(mode: ViewMode, context: ViewContext) {
    this.mode = mode;
    this.context = context;
    this.root.visible = false;
    this.context.worldRoot.add(this.root);
  }

  get object3d(): THREE.Object3D {
    return this.root;
  }

  get active(): boolean {
    return this._active;
  }

  activate(state: ViewState): void {
    this._active = true;
    this.root.visible = true;
    this.applyViewState(state);
  }

  deactivate(): void {
    this._active = false;
    this.root.visible = false;
  }

  update(_dtSeconds: number, _timeSeconds: number): void {
    // Optional for concrete views.
  }

  dispose(): void {
    this.context.worldRoot.remove(this.root);
  }

  abstract applyViewState(state: ViewState): void;
}

function normalizeLon(lon: number): number {
  const finite = finiteOrDefault(lon, DEFAULT_VIEW_STATE.centerLon);
  let out = finite % 360;
  if (out > 180) out -= 360;
  if (out <= -180) out += 360;
  return out;
}

function normalizeAngle(angle: number): number {
  const finite = finiteOrDefault(angle, 0);
  return ((finite % 360) + 360) % 360;
}

function finiteOrDefault(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
