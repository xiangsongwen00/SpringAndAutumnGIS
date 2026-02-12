import * as THREE from 'three';
import { GeoCoordinator, type LonLatHeight, type Vec3, type Wgs84OriginInput } from '../geo/coords';
import { CameraController, type CameraControllerOptions } from './CameraController';

export type EngineOptions = {
  container: HTMLElement;
  clearColor?: number;
  pixelRatio?: number;
  cameraFov?: number;
  cameraNear?: number;
  cameraFar?: number;
  geo?: GeoCoordinator;
  cameraController?: false | CameraControllerOptions;
};

export class Engine {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly geo: GeoCoordinator;
  readonly worldRoot: THREE.Group;
  readonly cameraController: CameraController | null;

  private _rafId: number | null = null;
  private _onResize: (() => void) | null = null;
  private _lastFrameTimeMs = 0;
  private readonly _updateHandlers = new Set<(dtSeconds: number, timeSeconds: number) => void>();

  constructor(options: EngineOptions) {
    const {
      container,
      clearColor = 0x0d1117,
      pixelRatio = window.devicePixelRatio,
      cameraFov = 60,
      cameraNear = 0.1,
      cameraFar = 1_000_000,
      geo,
      cameraController
    } = options;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(cameraFov, 1, cameraNear, cameraFar);
    this.camera.position.set(0, 120, 240);
    this.geo = geo ?? new GeoCoordinator();

    this.worldRoot = new THREE.Group();
    this.scene.add(this.worldRoot);
    this.applyRenderOriginOffset();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setClearColor(clearColor, 1);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);

    this.cameraController =
      cameraController === false
        ? null
        : new CameraController(this.camera, this.renderer.domElement, cameraController);

    container.appendChild(this.renderer.domElement);

    this.addDefaultLights();
    this.handleResize(container);
  }

  start(): void {
    if (this._rafId !== null) return;
    this._lastFrameTimeMs = 0;

    const loop = (nowMs: number) => {
      this._rafId = requestAnimationFrame(loop);
      const dtSeconds =
        this._lastFrameTimeMs === 0 ? 0 : Math.max(0, (nowMs - this._lastFrameTimeMs) / 1000);
      this._lastFrameTimeMs = nowMs;

      this.cameraController?.update();

      for (const handler of this._updateHandlers) {
        handler(dtSeconds, nowMs / 1000);
      }

      this.renderer.render(this.scene, this.camera);
    };

    this._rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this._rafId === null) return;
    cancelAnimationFrame(this._rafId);
    this._rafId = null;
    this._lastFrameTimeMs = 0;
  }

  dispose(): void {
    this.stop();
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }
    this.cameraController?.dispose();
    this.renderer.dispose();
    const canvas = this.renderer.domElement;
    if (canvas.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }
  }

  addWorldObject(object: THREE.Object3D): void {
    this.worldRoot.add(object);
  }

  addUpdateHandler(handler: (dtSeconds: number, timeSeconds: number) => void): () => void {
    this._updateHandlers.add(handler);
    return () => {
      this._updateHandlers.delete(handler);
    };
  }

  resolveEnuOrigin(originInput?: Wgs84OriginInput): LonLatHeight {
    return this.geo.resolveEnuOrigin(originInput, {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z
    });
  }

  getCameraWorldPosition(): Vec3 {
    return this.geo.renderToWorld({
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z
    });
  }

  worldToRenderPosition(world: Vec3): Vec3 {
    return this.geo.worldToRender(world);
  }

  renderToWorldPosition(render: Vec3): Vec3 {
    return this.geo.renderToWorld(render);
  }

  setRenderOrigin(threeWorld: Vec3, keepWorldCamera = true): Vec3 {
    const prev = this.geo.renderOriginThree;

    if (keepWorldCamera) {
      const delta = {
        x: prev.x - threeWorld.x,
        y: prev.y - threeWorld.y,
        z: prev.z - threeWorld.z
      };

      this.camera.position.set(
        this.camera.position.x + delta.x,
        this.camera.position.y + delta.y,
        this.camera.position.z + delta.z
      );
      this.cameraController?.offsetTarget(delta);
    }

    const next = this.geo.setRenderOriginThree(threeWorld);
    this.applyRenderOriginOffset();
    return next;
  }

  rebaseRenderOriginToCamera(): Vec3 {
    const cameraWorld = this.getCameraWorldPosition();
    return this.setRenderOrigin(cameraWorld, true);
  }

  private addDefaultLights(): void {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 0.7);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(200, 300, 200);
    this.scene.add(hemi, dir);
  }

  private applyRenderOriginOffset(): void {
    const origin = this.geo.renderOriginThree;
    this.worldRoot.position.set(-origin.x, -origin.y, -origin.z);
  }

  private handleResize(container: HTMLElement): void {
    this._onResize = () => {
      const { clientWidth, clientHeight } = container;
      this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(clientWidth, clientHeight);
    };

    window.addEventListener('resize', this._onResize);
    this._onResize();
  }
}
