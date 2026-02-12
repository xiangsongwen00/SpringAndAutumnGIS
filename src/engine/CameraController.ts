import * as THREE from 'three';
import type { Vec3 } from '../geo/coords';

export type CameraControllerOptions = {
  target?: Vec3;
  enabled?: boolean;
  enableDamping?: boolean;
  dampingFactor?: number;
  rotateSpeed?: number;
  panSpeed?: number;
  zoomSpeed?: number;
  minDistance?: number;
  maxDistance?: number;
  minPolarAngle?: number;
  maxPolarAngle?: number;
};

type PointerAction = 'none' | 'rotate' | 'pan';

export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLElement;

  enabled: boolean;
  enableDamping: boolean;
  dampingFactor: number;
  rotateSpeed: number;
  panSpeed: number;
  zoomSpeed: number;
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;

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
    this.dampingFactor = options?.dampingFactor ?? 0.12;
    this.rotateSpeed = options?.rotateSpeed ?? 1;
    this.panSpeed = options?.panSpeed ?? 1;
    this.zoomSpeed = options?.zoomSpeed ?? 1;
    this.minDistance = options?.minDistance ?? 1;
    this.maxDistance = options?.maxDistance ?? Number.POSITIVE_INFINITY;
    this.minPolarAngle = options?.minPolarAngle ?? 0;
    this.maxPolarAngle = options?.maxPolarAngle ?? Math.PI;

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
    this._spherical.radius *= 1 + (this._zoomScale - 1) * damping;

    this._spherical.phi = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, this._spherical.phi));
    this._spherical.makeSafe();
    this._spherical.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this._spherical.radius));

    this._target.addScaledVector(this._panOffset, damping);

    this._offset.setFromSpherical(this._spherical);
    this.camera.position.copy(this._target).add(this._offset);
    this.camera.lookAt(this._target);

    if (this.enableDamping) {
      const remain = Math.max(0, 1 - this.dampingFactor);
      this._sphericalDelta.theta *= remain;
      this._sphericalDelta.phi *= remain;
      this._panOffset.multiplyScalar(remain);
      this._zoomScale = 1 + (this._zoomScale - 1) * remain;
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

    const zoom = Math.exp(event.deltaY * 0.001 * this.zoomSpeed);
    this._zoomScale *= zoom;
  }

  private handleRotate(event: PointerEvent): void {
    const dx = event.clientX - this._rotateStart.x;
    const dy = event.clientY - this._rotateStart.y;

    this._rotateStart.set(event.clientX, event.clientY);

    const height = Math.max(this.domElement.clientHeight, 1);
    this._sphericalDelta.theta -= (2 * Math.PI * dx * this.rotateSpeed) / height;
    this._sphericalDelta.phi -= (2 * Math.PI * dy * this.rotateSpeed) / height;
  }

  private handlePan(event: PointerEvent): void {
    const dx = event.clientX - this._panStart.x;
    const dy = event.clientY - this._panStart.y;
    this._panStart.set(event.clientX, event.clientY);

    const height = Math.max(this.domElement.clientHeight, 1);
    const distance = this.camera.position.distanceTo(this._target);
    const worldPerPixel = (2 * distance * Math.tan((this.camera.fov * Math.PI) / 360)) / height;

    const panX = -dx * worldPerPixel * this.panSpeed;
    const panY = dy * worldPerPixel * this.panSpeed;

    this.camera.updateMatrix();
    this._right.setFromMatrixColumn(this.camera.matrix, 0);
    this._up.setFromMatrixColumn(this.camera.matrix, 1);

    this._panOffset.addScaledVector(this._right, panX);
    this._panOffset.addScaledVector(this._up, panY);
  }
}
