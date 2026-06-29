import * as THREE from 'three';
import type { Vec3 } from '../geo/coords';

export type CameraControllerOptions = {
  target?: Vec3;
  enabled?: boolean;
  enableDamping?: boolean;
  dampingFactor?: number;
  minDampingDelta?: number;
  rotateSpeed?: number;
  minRotateScale?: number;
  rotateAltitudeReference?: number;
  orbitRadius?: number;
  horizontalDragOnly?: boolean;
  panSpeed?: number;
  panMercatorScale?: number;
  maxPanMetersPerPixel?: number;
  zoomSpeed?: number;
  minZoomScale?: number;
  maxZoomScale?: number;
  minWheelZoomFactor?: number;
  maxWheelZoomFactor?: number;
  minDistance?: number;
  maxDistance?: number;
  minPolarAngle?: number;
  maxPolarAngle?: number;
  lockTarget?: boolean;
};

type PointerAction = 'none' | 'rotate' | 'pan';

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLElement;

  enabled: boolean;
  enableDamping: boolean;
  dampingFactor: number;
  minDampingDelta: number;
  rotateSpeed: number;
  minRotateScale: number;
  rotateAltitudeReference: number;
  orbitRadius: number;
  horizontalDragOnly: boolean;
  panSpeed: number;
  panMercatorScale: number;
  maxPanMetersPerPixel: number;
  zoomSpeed: number;
  minZoomScale: number;
  maxZoomScale: number;
  minWheelZoomFactor: number;
  maxWheelZoomFactor: number;
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;
  lockTarget: boolean;

  private readonly _target = new THREE.Vector3();
  private readonly _spherical = new THREE.Spherical();
  private readonly _sphericalDelta = new THREE.Spherical(1, 0, 0);
  private readonly _panOffset = new THREE.Vector3();
  private _zoomScale = 1;

  private _action: PointerAction = 'none';
  private readonly _rotateStart = new THREE.Vector2();
  private readonly _panStart = new THREE.Vector2();
  private readonly _offset = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _dragPrevGlobeDir = new THREE.Vector3();
  private readonly _dragNextGlobeDir = new THREE.Vector3();
  private readonly _dragStartGlobeDir = new THREE.Vector3();
  private readonly _dragStartCameraPosition = new THREE.Vector3();
  private readonly _dragStartCameraUp = new THREE.Vector3();
  private readonly _dragStartCameraMatrixWorld = new THREE.Matrix4();
  private readonly _dragStartProjectionMatrixInverse = new THREE.Matrix4();
  private readonly _rayPoint = new THREE.Vector3();
  private readonly _rayDirection = new THREE.Vector3();
  private readonly _rayOriginRel = new THREE.Vector3();
  private readonly _dragRotation = new THREE.Quaternion();
  private _hasDragPrevGlobeDir = false;
  private _hasDragStartGlobeDir = false;

  private readonly _onContextMenuBound: (event: Event) => void;
  private readonly _onPointerDownBound: (event: PointerEvent) => void;
  private readonly _onPointerMoveBound: (event: PointerEvent) => void;
  private readonly _onPointerUpBound: (event: PointerEvent) => void;
  private readonly _onWheelBound: (event: WheelEvent) => void;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement, options?: CameraControllerOptions) {
    this.camera = camera;
    this.domElement = domElement;

    this.enabled = options?.enabled ?? true;
    this.enableDamping = options?.enableDamping ?? true;
    this.dampingFactor = options?.dampingFactor ?? 0.28;
    this.minDampingDelta = options?.minDampingDelta ?? 1e-5;
    this.rotateSpeed = options?.rotateSpeed ?? 1;
    this.minRotateScale = options?.minRotateScale ?? 0.035;
    this.rotateAltitudeReference = options?.rotateAltitudeReference ?? 1_500_000;
    this.orbitRadius = Math.max(1, options?.orbitRadius ?? 1);
    this.horizontalDragOnly = options?.horizontalDragOnly ?? false;
    this.panSpeed = options?.panSpeed ?? 1;
    this.panMercatorScale = options?.panMercatorScale ?? 0.12;
    this.maxPanMetersPerPixel = options?.maxPanMetersPerPixel ?? 50_000;
    this.zoomSpeed = options?.zoomSpeed ?? 1;
    this.minZoomScale = options?.minZoomScale ?? 0.2;
    this.maxZoomScale = options?.maxZoomScale ?? 5;
    this.minWheelZoomFactor = options?.minWheelZoomFactor ?? 0.88;
    this.maxWheelZoomFactor = options?.maxWheelZoomFactor ?? 1.14;
    this.minDistance = options?.minDistance ?? 1;
    this.maxDistance = options?.maxDistance ?? Number.POSITIVE_INFINITY;
    this.minPolarAngle = options?.minPolarAngle ?? 0;
    this.maxPolarAngle = options?.maxPolarAngle ?? Math.PI;
    this.lockTarget = options?.lockTarget ?? false;
    this.camera.up.set(0, 1, 0);

    if (options?.target) {
      this._target.set(options.target.x, options.target.y, options.target.z);
    }

    this.camera.lookAt(this._target);
    this.syncSphericalFromCamera();

    this._onContextMenuBound = (event) => {
      event.preventDefault();
    };
    this._onPointerDownBound = (event) => {
      this.onPointerDown(event);
    };
    this._onPointerMoveBound = (event) => {
      this.onPointerMove(event);
    };
    this._onPointerUpBound = (event) => {
      this.onPointerUp(event);
    };
    this._onWheelBound = (event) => {
      this.onWheel(event);
    };

    this.domElement.addEventListener('contextmenu', this._onContextMenuBound);
    this.domElement.addEventListener('pointerdown', this._onPointerDownBound);
    this.domElement.addEventListener('wheel', this._onWheelBound, { passive: false });
  }

  dispose(): void {
    this.domElement.removeEventListener('contextmenu', this._onContextMenuBound);
    this.domElement.removeEventListener('pointerdown', this._onPointerDownBound);
    this.domElement.removeEventListener('wheel', this._onWheelBound);
    window.removeEventListener('pointermove', this._onPointerMoveBound);
    window.removeEventListener('pointerup', this._onPointerUpBound);
  }

  get target(): Vec3 {
    return { x: this._target.x, y: this._target.y, z: this._target.z };
  }

  setTarget(target: Vec3): void {
    if (
      Math.abs(this._target.x - target.x) < 1e-6 &&
      Math.abs(this._target.y - target.y) < 1e-6 &&
      Math.abs(this._target.z - target.z) < 1e-6
    ) {
      return;
    }
    this._target.set(target.x, target.y, target.z);
    this.syncSphericalFromCamera();
  }

  offsetTarget(delta: Vec3): void {
    this._target.add(new THREE.Vector3(delta.x, delta.y, delta.z));
  }

  update(): boolean {
    if (!this.enabled) return false;

    const damping = this.enableDamping ? this.dampingFactor : 1;

    this._offset.copy(this.camera.position).sub(this._target);
    this._spherical.setFromVector3(this._offset);

    this._spherical.theta += this._sphericalDelta.theta * damping;
    this._spherical.phi += this._sphericalDelta.phi * damping;
    this._spherical.radius = this.resolveDampedZoomRadius(this._spherical.radius, damping);

    this._spherical.phi = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, this._spherical.phi));
    this._spherical.makeSafe();
    this._spherical.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this._spherical.radius));

    if (!this.lockTarget) {
      this._target.addScaledVector(this._panOffset, damping);
    }

    this._offset.setFromSpherical(this._spherical);
    this.camera.position.copy(this._target).add(this._offset);
    if (!this.lockTarget || this.orbitRadius <= 1) {
      this.camera.up.set(0, 1, 0);
    } else {
      this.camera.up.normalize();
    }
    this.camera.lookAt(this._target);

    if (this.enableDamping) {
      const remain = Math.max(0, 1 - this.dampingFactor);
      this._sphericalDelta.theta *= remain;
      this._sphericalDelta.phi *= remain;
      this._panOffset.multiplyScalar(remain);
      this._zoomScale = 1 + (this._zoomScale - 1) * remain;
      this.snapDampingResiduals();
    } else {
      this._sphericalDelta.theta = 0;
      this._sphericalDelta.phi = 0;
      this._panOffset.set(0, 0, 0);
      this._zoomScale = 1;
    }

    return true;
  }

  private syncSphericalFromCamera(): void {
    this._offset.copy(this.camera.position).sub(this._target);
    this._spherical.setFromVector3(this._offset);
    this._spherical.makeSafe();
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.enabled) return;

    if (event.button === 0) {
      this._action = 'rotate';
      this._rotateStart.set(event.clientX, event.clientY);
      this.captureDragStartCamera();
      this._hasDragStartGlobeDir = this.resolveGlobeDirectionAtClientFromDragStart(
        event.clientX,
        event.clientY,
        this._dragStartGlobeDir
      );
      this._hasDragPrevGlobeDir = this._hasDragStartGlobeDir;
      if (this._hasDragStartGlobeDir) {
        this._dragPrevGlobeDir.copy(this._dragStartGlobeDir);
      }
    } else if (event.button === 1 || event.button === 2) {
      this._action = 'pan';
      this._panStart.set(event.clientX, event.clientY);
    } else {
      this._action = 'none';
      return;
    }

    this.domElement.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', this._onPointerMoveBound);
    window.addEventListener('pointerup', this._onPointerUpBound);
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.enabled) return;

    if (this._action === 'rotate') {
      this.handleRotate(event);
      return;
    }

    if (this._action === 'pan') {
      this.handlePan(event);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    this._action = 'none';
    this._hasDragPrevGlobeDir = false;
    this._hasDragStartGlobeDir = false;
    try {
      this.domElement.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore if capture was already released.
    }
    window.removeEventListener('pointermove', this._onPointerMoveBound);
    window.removeEventListener('pointerup', this._onPointerUpBound);
  }

  private onWheel(event: WheelEvent): void {
    if (!this.enabled) return;
    event.preventDefault();

    const normalizedDelta = clampNumber(event.deltaY, -120, 120);
    const rawZoom = Math.exp(normalizedDelta * 0.001 * this.zoomSpeed);
    const zoom = clampNumber(rawZoom, this.minWheelZoomFactor, this.maxWheelZoomFactor);
    this._zoomScale = clampNumber(this._zoomScale * zoom, this.minZoomScale, this.maxZoomScale);
  }

  private handleRotate(event: PointerEvent): void {
    if (this.lockTarget && this.orbitRadius > 1 && this.handleGlobeSurfaceDrag(event)) {
      return;
    }

    const dx = event.clientX - this._rotateStart.x;
    const dy = event.clientY - this._rotateStart.y;

    this._rotateStart.set(event.clientX, event.clientY);

    const height = Math.max(this.domElement.clientHeight, 1);
    const radiansPerPixel = this.resolveOrbitRadiansPerPixel(height);
    this._sphericalDelta.theta -= dx * radiansPerPixel * this.rotateSpeed;
    if (!this.horizontalDragOnly) {
      this._sphericalDelta.phi -= dy * radiansPerPixel * this.rotateSpeed;
    }
  }

  private handleGlobeSurfaceDrag(event: PointerEvent): boolean {
    const hasNext = this.resolveGlobeDirectionAtClientFromDragStart(
      event.clientX,
      event.clientY,
      this._dragNextGlobeDir
    );
    if (!hasNext || !this._hasDragStartGlobeDir) {
      this._rotateStart.set(event.clientX, event.clientY);
      return false;
    }

    const dot = clampNumber(this._dragNextGlobeDir.dot(this._dragStartGlobeDir), -1, 1);
    if (dot > 0.999999) {
      this._rotateStart.set(event.clientX, event.clientY);
      return true;
    }

    this._dragRotation.setFromUnitVectors(this._dragNextGlobeDir, this._dragStartGlobeDir);
    this._offset.copy(this._dragStartCameraPosition).sub(this._target).applyQuaternion(this._dragRotation);
    this.camera.position.copy(this._target).add(this._offset);
    this.camera.up.copy(this._dragStartCameraUp).applyQuaternion(this._dragRotation).normalize();
    this.camera.lookAt(this._target);
    this.syncSphericalFromCamera();
    this._sphericalDelta.theta = 0;
    this._sphericalDelta.phi = 0;
    this._zoomScale = 1;
    this._rotateStart.set(event.clientX, event.clientY);
    return true;
  }

  private captureDragStartCamera(): void {
    this.camera.updateMatrixWorld();
    this.camera.updateProjectionMatrix();
    this._dragStartCameraPosition.copy(this.camera.position);
    this._dragStartCameraUp.copy(this.camera.up).normalize();
    this._dragStartCameraMatrixWorld.copy(this.camera.matrixWorld);
    this._dragStartProjectionMatrixInverse.copy(this.camera.projectionMatrixInverse);
  }

  private resolveGlobeDirectionAtClientFromDragStart(
    clientX: number,
    clientY: number,
    out: THREE.Vector3
  ): boolean {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this._rayPoint
      .set(ndcX, ndcY, 0.5)
      .applyMatrix4(this._dragStartProjectionMatrixInverse)
      .applyMatrix4(this._dragStartCameraMatrixWorld);
    this._rayDirection.copy(this._rayPoint).sub(this._dragStartCameraPosition).normalize();
    this._rayOriginRel.copy(this._dragStartCameraPosition).sub(this._target);

    const b = this._rayOriginRel.dot(this._rayDirection);
    const c = this._rayOriginRel.lengthSq() - this.orbitRadius * this.orbitRadius;
    const disc = b * b - c;
    if (disc < 0) return false;

    const sqrtDisc = Math.sqrt(disc);
    const t0 = -b - sqrtDisc;
    const t1 = -b + sqrtDisc;
    const t = t0 > 1e-6 ? t0 : t1 > 1e-6 ? t1 : -1;
    if (t <= 0) return false;

    out.copy(this._rayOriginRel).addScaledVector(this._rayDirection, t).normalize();
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
  }

  private handlePan(event: PointerEvent): void {
    if (this.lockTarget) {
      this._panStart.set(event.clientX, event.clientY);
      return;
    }

    const dx = event.clientX - this._panStart.x;
    const dy = event.clientY - this._panStart.y;
    this._panStart.set(event.clientX, event.clientY);

    const height = Math.max(this.domElement.clientHeight, 1);
    const worldPerPixel = this.resolvePanWorldPerPixel(height);

    const panX = -dx * worldPerPixel * this.panSpeed;
    const panY = dy * worldPerPixel * this.panSpeed;

    this.camera.updateMatrix();
    this._right.setFromMatrixColumn(this.camera.matrix, 0);
    this._up.setFromMatrixColumn(this.camera.matrix, 1);

    this._panOffset.addScaledVector(this._right, panX);
    this._panOffset.addScaledVector(this._up, panY);
  }

  private snapDampingResiduals(): void {
    if (Math.abs(this._sphericalDelta.theta) < this.minDampingDelta) {
      this._sphericalDelta.theta = 0;
    }
    if (Math.abs(this._sphericalDelta.phi) < this.minDampingDelta) {
      this._sphericalDelta.phi = 0;
    }
    if (this._panOffset.lengthSq() < this.minDampingDelta * this.minDampingDelta) {
      this._panOffset.set(0, 0, 0);
    }
    if (Math.abs(this._zoomScale - 1) < this.minDampingDelta) {
      this._zoomScale = 1;
    }
  }

  private resolveDampedZoomRadius(radius: number, damping: number): number {
    const safeMinDistance = Math.max(1, this.minDistance);
    const minAltitude = 1e-3;
    const altitude = Math.max(minAltitude, radius - safeMinDistance);
    const altitudeScale = 1 + (this._zoomScale - 1) * damping;
    const nextAltitude = altitude * Math.max(0.01, altitudeScale);
    return safeMinDistance + nextAltitude;
  }

  private resolveNavigationAltitude(): number {
    return Math.max(1e-3, this.camera.position.distanceTo(this._target) - Math.max(1, this.minDistance));
  }

  private resolveRotateScale(): number {
    const altitude = this.resolveNavigationAltitude();
    const reference = Math.max(1, this.rotateAltitudeReference);
    return clampNumber(Math.sqrt(altitude / reference), this.minRotateScale, 1);
  }

  private resolveOrbitRadiansPerPixel(viewportHeight: number): number {
    if (!this.lockTarget || this.orbitRadius <= 1) {
      const rotateScale = this.resolveRotateScale();
      return (2 * Math.PI * rotateScale) / Math.max(viewportHeight, 1);
    }

    const distance = Math.max(1, this.camera.position.distanceTo(this._target));
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const projectedRadiusPx =
      (Math.max(viewportHeight, 1) * this.orbitRadius) / (2 * distance * Math.tan(fovRad * 0.5));
    const safeProjectedRadiusPx = clampNumber(projectedRadiusPx, viewportHeight * 0.35, viewportHeight * 4);
    return 1 / safeProjectedRadiusPx;
  }

  private resolvePanWorldPerPixel(viewportHeight: number): number {
    const altitude = this.resolveNavigationAltitude();
    const distance = Math.max(altitude, this.minDistance * 0.0005);
    const perspectiveMetersPerPixel =
      (2 * distance * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(viewportHeight, 1);
    const zoom = altitudeToContinuousZoom(altitude);
    const mercatorMetersPerPixel = (156543.03392804097 / 2 ** zoom) * this.panMercatorScale;
    return Math.min(perspectiveMetersPerPixel, mercatorMetersPerPixel, this.maxPanMetersPerPixel);
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function altitudeToContinuousZoom(altitudeMeters: number): number {
  const earthCircumferenceMeters = 40_075_016.68557849;
  const altitude = Math.max(0.001, altitudeMeters);
  return clampNumber(Math.log2(earthCircumferenceMeters / Math.max(0.001, altitude)) - 1, 0, 29);
}
