import * as THREE from 'three';
import { CoordinateTransform } from '../core/coordinates/CoordinateTransform';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type { TerrainHeightSource } from '../render/TerrainTileLayer';

export type GlobeFlyToOptions = {
  longitude: number;
  latitude: number;
  /** Camera height above the terrain/ellipsoid at the destination, in metres. */
  altitude: number;
  /** Clockwise from north, in degrees. */
  heading?: number;
  /** Cesium-style pitch: -90 is nadir, 0 is horizontal. */
  pitch?: number;
  duration?: number;
};

export type GlobeCameraViewState = Readonly<{
  cameraLongitude: number;
  cameraLatitude: number;
  cameraAltitude: number;
  focusLongitude: number | null;
  focusLatitude: number | null;
  heading: number | null;
  pitch: number | null;
}>;

type DragMode = 'globe' | 'look' | 'tilt';
type CameraAnimation = {
  startTime: number;
  duration: number;
  startPosition: THREE.Vector3;
  endPosition: THREE.Vector3;
  startQuaternion: THREE.Quaternion;
  endQuaternion: THREE.Quaternion;
  startUp: THREE.Vector3;
  endUp: THREE.Vector3;
  endTarget: THREE.Vector3;
};

/** Cesium-style globe navigation with focus orbit, surface tilt and fly-to animation. */
export class GlobeCameraController {
  readonly target = new THREE.Vector3();
  enabled = true;
  enableDamping = true;
  dampingFactor = 0.1;
  orbitSpeed = 0.38;
  lookSpeed = 1;
  tiltSpeed = 1;
  zoomSpeed = 0.42;
  minDistance = 1;
  maxDistance = Number.POSITIVE_INFINITY;
  minimumTiltDegrees = 0;
  maximumTiltDegrees = 85;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly element: HTMLElement;
  private readonly ellipsoid: Ellipsoid;
  private readonly coordinates: CoordinateTransform;
  private readonly terrain?: TerrainHeightSource;
  private readonly pointer = new THREE.Vector2();
  private readonly orbitVelocity = new THREE.Vector2();
  private readonly lookVelocity = new THREE.Vector2();
  private tiltVelocity = 0;
  private zoomVelocity = 0;
  private pointerId: number | null = null;
  private dragMode: DragMode | null = null;
  private animation: CameraAnimation | null = null;
  private terrainRevision = -1;
  private disposed = false;

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.pointerId !== null) return;
    const mode = pointerMode(event.button);
    if (!mode) return;
    event.preventDefault();
    this.cancelAnimation();
    this.pointerId = event.pointerId;
    this.dragMode = mode;
    this.pointer.set(event.clientX, event.clientY);
    this.element.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled || event.pointerId !== this.pointerId || !this.dragMode) return;
    event.preventDefault();
    const deltaX = event.clientX - this.pointer.x;
    const deltaY = event.clientY - this.pointer.y;
    this.pointer.set(event.clientX, event.clientY);
    if (this.dragMode === 'globe') {
      this.orbitVelocity.x += -deltaX * 0.003 * this.orbitSpeed * this.inputGain();
      this.orbitVelocity.y += -deltaY * 0.003 * this.orbitSpeed * this.inputGain();
    } else if (this.dragMode === 'look') {
      this.lookVelocity.x += -deltaX * 0.003 * this.lookSpeed * this.inputGain();
      this.lookVelocity.y += -deltaY * 0.003 * this.lookSpeed * this.inputGain();
    } else {
      this.tiltVelocity += -deltaY * 0.003 * this.tiltSpeed * this.inputGain();
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) return;
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
    this.pointerId = null;
    this.dragMode = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    this.cancelAnimation();
    const delta = normalizeWheelDelta(event);
    this.zoomVelocity += THREE.MathUtils.clamp(delta, -4, 4) * this.zoomSpeed * this.inputGain();
  };

  private readonly onContextMenu = (event: MouseEvent): void => event.preventDefault();

  constructor(
    camera: THREE.PerspectiveCamera,
    element: HTMLElement,
    ellipsoid = Ellipsoid.WGS84,
    terrain?: TerrainHeightSource
  ) {
    this.camera = camera;
    this.element = element;
    this.ellipsoid = ellipsoid;
    this.coordinates = new CoordinateTransform(ellipsoid);
    this.terrain = terrain;
    this.element.style.touchAction = 'none';
    this.element.addEventListener('pointerdown', this.onPointerDown);
    this.element.addEventListener('pointermove', this.onPointerMove);
    this.element.addEventListener('pointerup', this.onPointerUp);
    this.element.addEventListener('pointercancel', this.onPointerUp);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('contextmenu', this.onContextMenu);
  }

  update(now = performance.now()): boolean {
    if (this.disposed) return false;
    let changed = this.updateAnimation(now);
    if (!this.enabled || this.animation) return changed;

    if (this.orbitVelocity.lengthSq() > 1e-12) {
      changed = this.orbitAroundGlobe(
        this.orbitVelocity.x,
        this.orbitVelocity.y
      ) || changed;
    }
    if (this.lookVelocity.lengthSq() > 1e-12) {
      changed = this.orbitAroundSurface(
        this.lookVelocity.x,
        this.lookVelocity.y
      ) || changed;
    }
    if (Math.abs(this.tiltVelocity) > 1e-7) {
      changed = this.tiltAroundSurface(this.tiltVelocity) || changed;
    }
    if (Math.abs(this.zoomVelocity) > 1e-7) {
      this.zoomAlongView(this.zoomVelocity);
      changed = true;
    }
    this.enforceDistance();
    this.decayVelocities();
    const terrainChanged = this.terrain !== undefined &&
      this.terrain.revision !== this.terrainRevision;
    if (changed || terrainChanged || !this.validTarget()) this.updateTargetFromView();
    this.terrainRevision = this.terrain?.revision ?? -1;
    return changed;
  }

  getViewState(): GlobeCameraViewState {
    const cameraPosition = this.coordinates.worldToGeodetic(this.camera.position);
    const focus = this.validTarget() ?? this.surfaceFocus();
    if (!focus) {
      return {
        cameraLongitude: cameraPosition.longitude,
        cameraLatitude: cameraPosition.latitude,
        cameraAltitude: cameraPosition.height,
        focusLongitude: null,
        focusLatitude: null,
        heading: null,
        pitch: null
      };
    }
    const focusPosition = this.coordinates.worldToGeodetic(focus);
    const frame = this.localFrame(focusPosition.longitude, focusPosition.latitude);
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(forward.dot(frame.up), -1, 1)));
    const heading = normalizeDegrees(THREE.MathUtils.radToDeg(Math.atan2(
      forward.dot(frame.east),
      forward.dot(frame.north)
    )));
    return {
      cameraLongitude: cameraPosition.longitude,
      cameraLatitude: cameraPosition.latitude,
      cameraAltitude: cameraPosition.height,
      focusLongitude: focusPosition.longitude,
      focusLatitude: focusPosition.latitude,
      heading,
      pitch
    };
  }

  flyTo(options: GlobeFlyToOptions): void {
    const destination = this.destinationCamera(options);
    const duration = Math.max(0, options.duration ?? 1800);
    this.resetVelocities();
    if (duration === 0) {
      this.camera.position.copy(destination.position);
      this.camera.quaternion.copy(destination.quaternion);
      this.camera.up.copy(destination.up);
      this.target.copy(destination.target);
      this.enforceDistance();
      return;
    }
    this.animation = {
      startTime: performance.now(),
      duration,
      startPosition: this.camera.position.clone(),
      endPosition: destination.position,
      startQuaternion: this.camera.quaternion.clone(),
      endQuaternion: destination.quaternion,
      startUp: this.camera.up.clone(),
      endUp: destination.up,
      endTarget: destination.target
    };
  }

  cancelAnimation(): void {
    this.animation = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('pointercancel', this.onPointerUp);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
  }

  private orbitAroundGlobe(yaw: number, pitch: number): boolean {
    const yawRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
    const pitchRotation = new THREE.Quaternion().setFromAxisAngle(right, pitch);
    const rotation = pitchRotation.multiply(yawRotation);
    const nextPosition = this.camera.position.clone().applyQuaternion(rotation);
    const polar = Math.acos(THREE.MathUtils.clamp(nextPosition.y / nextPosition.length(), -1, 1));
    if (polar < 0.015 || polar > Math.PI - 0.015) {
      this.orbitVelocity.set(0, 0);
      return false;
    }
    this.camera.position.copy(nextPosition);
    this.camera.quaternion.premultiply(rotation).normalize();
    this.camera.up.applyQuaternion(rotation).normalize();
    this.target.applyQuaternion(rotation);
    this.stabilizeHorizon(this.target, this.camera.up);
    return true;
  }

  private tiltAroundSurface(angle: number): boolean {
    return this.orbitAroundSurface(0, angle);
  }

  private orbitAroundSurface(yaw: number, pitch: number): boolean {
    const pivot = this.surfacePivot();
    if (!pivot) return false;
    const pivotNormal = this.surfaceNormal(pivot);
    const offset = this.camera.position.clone().sub(pivot);
    const yawRotation = new THREE.Quaternion().setFromAxisAngle(pivotNormal, yaw);
    const offsetAfterYaw = offset.applyQuaternion(yawRotation);
    // The camera's local right vector can accumulate roll after globe orbiting
    // and is not guaranteed to remain tangent to the ellipsoid. Derive the
    // pitch axis from the surface normal and camera offset so middle-drag
    // always changes elevation, regardless of heading or accumulated roll.
    const pitchAxis = pivotNormal.clone().cross(offsetAfterYaw.clone().normalize());
    if (pitchAxis.lengthSq() <= 1e-12) {
      pitchAxis.set(1, 0, 0)
        .applyQuaternion(this.camera.quaternion)
        .applyQuaternion(yawRotation)
        .normalize();
      // At exact nadir both signs describe a valid tangent axis. Pick the one
      // whose infinitesimal positive tilt makes the physical horizon-up agree
      // with the transported screen-up, preventing a delayed 180deg flip when
      // the surface-normal projection becomes large enough to use again.
      const probeOffset = offsetAfterYaw.clone().applyAxisAngle(pitchAxis, 1e-4);
      const probeForward = probeOffset.clone().negate().normalize();
      const probeUp = pivotNormal.clone().addScaledVector(
        probeForward,
        -pivotNormal.dot(probeForward)
      ).normalize();
      const transportedUp = this.camera.up.clone().applyQuaternion(yawRotation);
      transportedUp.addScaledVector(probeForward, -transportedUp.dot(probeForward)).normalize();
      if (probeUp.dot(transportedUp) < 0) pitchAxis.negate();
    } else pitchAxis.normalize();
    const currentTilt = Math.acos(THREE.MathUtils.clamp(
      offsetAfterYaw.clone().normalize().dot(pivotNormal),
      -1,
      1
    ));
    const minimumTilt = THREE.MathUtils.degToRad(this.minimumTiltDegrees);
    const maximumTilt = THREE.MathUtils.degToRad(this.maximumTiltDegrees);
    let pitchAmount = pitch;
    if (currentTilt < minimumTilt) {
      pitchAmount = pitch > 0 ? Math.min(pitch, minimumTilt - currentTilt) : 0;
    } else if (currentTilt > maximumTilt) {
      pitchAmount = pitch < 0 ? Math.max(pitch, maximumTilt - currentTilt) : 0;
    } else {
      // The unsigned angle of the final offset cannot tell whether a pitch
      // crossed through nadir. Clamp the signed delta before rotating so the
      // camera can never pass through that singularity and flip by 180deg.
      pitchAmount = THREE.MathUtils.clamp(
        pitch,
        minimumTilt - currentTilt,
        maximumTilt - currentTilt
      );
    }
    if (Math.abs(pitchAmount) < 1e-7) pitchAmount = 0;
    if (pitchAmount === 0 || Math.abs(pitchAmount) < Math.abs(pitch) * 0.999) {
      this.lookVelocity.y = 0;
      this.tiltVelocity = 0;
    }
    const pitchRotation = new THREE.Quaternion().setFromAxisAngle(pitchAxis, pitchAmount);
    const nextOffset = offsetAfterYaw.clone().applyQuaternion(pitchRotation);
    if (Math.abs(yaw) < 1e-10 && Math.abs(pitchAmount) < 1e-10) return false;
    this.camera.position.copy(pivot).add(nextOffset);
    const rotatedUp = this.camera.up.clone()
      .applyQuaternion(yawRotation)
      .applyQuaternion(pitchRotation);
    this.stabilizeHorizon(pivot, rotatedUp);
    this.target.copy(pivot);
    return true;
  }

  private tiltDegrees(offset: THREE.Vector3, normal: THREE.Vector3): number {
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(
      offset.clone().normalize().dot(normal),
      -1,
      1
    )));
  }

  private zoomAlongView(amount: number): void {
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const altitude = Math.max(0.1, this.altitudeAboveSurface());
    const scale = Math.exp(THREE.MathUtils.clamp(amount * 0.18, -0.7, 0.7));
    const distance = altitude * (scale - 1);
    this.camera.position.addScaledVector(forward, -distance);
  }

  private updateAnimation(now: number): boolean {
    const animation = this.animation;
    if (!animation) return false;
    const elapsed = Math.max(0, now - animation.startTime);
    const amount = THREE.MathUtils.clamp(elapsed / animation.duration, 0, 1);
    const eased = amount < 0.5
      ? 4 * amount * amount * amount
      : 1 - (-2 * amount + 2) ** 3 / 2;
    this.camera.position.lerpVectors(animation.startPosition, animation.endPosition, eased);
    this.camera.quaternion.slerpQuaternions(animation.startQuaternion, animation.endQuaternion, eased);
    this.camera.up.lerpVectors(animation.startUp, animation.endUp, eased).normalize();
    if (amount >= 1) {
      this.target.copy(animation.endTarget);
      this.animation = null;
      this.enforceDistance();
    }
    return true;
  }

  private destinationCamera(options: GlobeFlyToOptions): {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    up: THREE.Vector3;
    target: THREE.Vector3;
  } {
    const terrainHeight = this.terrain?.sampleHeight(options.longitude, options.latitude) ?? 0;
    const target = this.ellipsoid.cartographicToCartesian({
      longitude: options.longitude,
      latitude: options.latitude,
      height: terrainHeight
    });
    const frame = this.localFrame(options.longitude, options.latitude);
    const heading = THREE.MathUtils.degToRad(options.heading ?? 0);
    // Camera offset tilt is `90deg + pitch` for Cesium-style negative
    // pitches. Use the same interval as interactive surface orbiting so a
    // fly-to cannot start outside the legal observation plane.
    const minimumPitch = Math.max(-89.9, this.minimumTiltDegrees - 90);
    const maximumPitch = Math.min(-0.1, this.maximumTiltDegrees - 90);
    const pitch = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(
      options.pitch ?? -90,
      minimumPitch,
      Math.max(minimumPitch, maximumPitch)
    ));
    const horizontal = frame.north.clone().multiplyScalar(Math.cos(heading))
      .addScaledVector(frame.east, Math.sin(heading));
    const forward = horizontal.multiplyScalar(Math.cos(pitch))
      .addScaledVector(frame.up, Math.sin(pitch))
      .normalize();
    const desiredHeight = terrainHeight + Math.max(0.1, options.altitude);
    let lowerRange = 0;
    let upperRange = Math.max(
      1,
      Math.max(0.1, options.altitude) / Math.max(0.05, -forward.dot(frame.up))
    );
    while (
      this.coordinates.worldToGeodetic(
        target.clone().addScaledVector(forward, -upperRange)
      ).height < desiredHeight &&
      upperRange < this.ellipsoid.equatorialRadius * 64
    ) {
      upperRange *= 2;
    }
    for (let iteration = 0; iteration < 36; iteration += 1) {
      const middleRange = (lowerRange + upperRange) * 0.5;
      const middleHeight = this.coordinates.worldToGeodetic(
        target.clone().addScaledVector(forward, -middleRange)
      ).height;
      if (middleHeight < desiredHeight) lowerRange = middleRange;
      else upperRange = middleRange;
    }
    const range = upperRange;
    const position = target.clone().addScaledVector(forward, -range);
    const viewUp = frame.up.clone().addScaledVector(forward, -frame.up.dot(forward));
    if (viewUp.lengthSq() <= 1e-10) viewUp.copy(frame.north);
    viewUp.normalize();
    const matrix = new THREE.Matrix4().lookAt(position, target, viewUp);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(matrix);
    return { position, quaternion, up: viewUp, target };
  }

  private updateTargetFromView(): void {
    const focus = this.surfaceFocus();
    if (focus) this.target.copy(focus);
  }

  private surfaceFocus(): THREE.Vector3 | null {
    const direction = this.camera.getWorldDirection(new THREE.Vector3());
    const hit = intersectEllipsoid(this.camera.position, direction, this.ellipsoid);
    if (!hit) return this.validTarget();
    if (!this.terrain) return hit;

    // Solve along the actual centre ray. Reprojecting the ellipsoid hit to a
    // terrain height moves it off that ray, especially at grazing angles, and
    // slowly corrupts the retained pivot as new Terrain-RGB tiles arrive.
    let near = 0;
    let far = this.camera.position.distanceTo(hit);
    const cameraPosition = this.coordinates.worldToGeodetic(this.camera.position);
    const cameraTerrain = Math.max(
      0,
      this.terrain.sampleHeight(cameraPosition.longitude, cameraPosition.latitude) ?? 0
    );
    if (cameraPosition.height <= cameraTerrain) return this.validTarget() ?? hit;
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const distance = (near + far) * 0.5;
      const point = this.camera.position.clone().addScaledVector(direction, distance);
      const position = this.coordinates.worldToGeodetic(point);
      const terrainHeight = Math.max(
        0,
        this.terrain.sampleHeight(position.longitude, position.latitude) ?? 0
      );
      if (position.height > terrainHeight) near = distance;
      else far = distance;
    }
    return this.camera.position.clone().addScaledVector(direction, far);
  }

  private surfacePivot(): THREE.Vector3 | null {
    return this.validTarget() ?? this.surfaceFocus();
  }

  private validTarget(): THREE.Vector3 | null {
    return this.target.length() > this.ellipsoid.polarRadius * 0.5
      ? this.target.clone()
      : null;
  }

  private enforceDistance(): void {
    const distance = this.camera.position.length();
    let clamped = false;
    if (distance < this.minDistance) {
      this.camera.position.setLength(this.minDistance);
      clamped = true;
    } else if (distance > this.maxDistance) {
      this.camera.position.setLength(this.maxDistance);
      clamped = true;
    }
    // Radial distance clamping moves an oblique camera off its original view
    // ray. Re-aim at the retained surface target so zoom limits cannot leave
    // the camera looking into space.
    if (clamped && this.target.lengthSq() > 0) {
      this.stabilizeHorizon(this.target, this.camera.up);
    }
  }

  private stabilizeHorizon(pivot: THREE.Vector3, fallbackUp: THREE.Vector3): void {
    const forward = pivot.clone().sub(this.camera.position).normalize();
    const surfaceUp = this.surfaceNormal(pivot);
    const screenUp = surfaceUp.addScaledVector(forward, -surfaceUp.dot(forward));
    // At nadir the projected surface normal has no defined direction. Use the
    // transported camera-up vector throughout a small polar cap, otherwise
    // floating-point noise can normalize into either of two opposite vectors.
    const nadirProjectionThreshold = Math.sin(THREE.MathUtils.degToRad(1)) ** 2;
    if (screenUp.lengthSq() < nadirProjectionThreshold) {
      screenUp.copy(fallbackUp).addScaledVector(forward, -fallbackUp.dot(forward));
    }
    if (screenUp.lengthSq() <= 1e-10) {
      const focusPosition = this.coordinates.worldToGeodetic(pivot);
      screenUp.copy(this.localFrame(
        focusPosition.longitude,
        focusPosition.latitude
      ).north);
    }
    this.camera.up.copy(screenUp.normalize());
    this.camera.lookAt(pivot);
  }

  private altitudeAboveSurface(): number {
    const position = this.coordinates.worldToGeodetic(this.camera.position);
    const terrainHeight = this.terrain?.sampleHeight(position.longitude, position.latitude) ?? 0;
    return position.height - Math.max(0, terrainHeight);
  }

  private surfaceNormal(point: THREE.Vector3): THREE.Vector3 {
    const a2 = this.ellipsoid.equatorialRadius ** 2;
    const b2 = this.ellipsoid.polarRadius ** 2;
    return new THREE.Vector3(point.x / a2, point.y / b2, point.z / a2).normalize();
  }

  private localFrame(longitude: number, latitude: number): {
    east: THREE.Vector3;
    north: THREE.Vector3;
    up: THREE.Vector3;
  } {
    const longitudeRadians = THREE.MathUtils.degToRad(longitude);
    const latitudeRadians = THREE.MathUtils.degToRad(latitude);
    const sinLongitude = Math.sin(longitudeRadians);
    const cosLongitude = Math.cos(longitudeRadians);
    const sinLatitude = Math.sin(latitudeRadians);
    const cosLatitude = Math.cos(latitudeRadians);
    return {
      east: new THREE.Vector3(cosLongitude, 0, -sinLongitude),
      north: new THREE.Vector3(
        -sinLatitude * sinLongitude,
        cosLatitude,
        -sinLatitude * cosLongitude
      ),
      up: new THREE.Vector3(
        cosLatitude * sinLongitude,
        sinLatitude,
        cosLatitude * cosLongitude
      )
    };
  }

  private decayVelocities(): void {
    if (!this.enableDamping) {
      this.resetVelocities();
      return;
    }
    const retention = 1 - THREE.MathUtils.clamp(this.dampingFactor, 0.01, 1);
    this.orbitVelocity.multiplyScalar(retention);
    this.lookVelocity.multiplyScalar(retention);
    this.tiltVelocity *= retention;
    this.zoomVelocity *= retention;
    if (this.orbitVelocity.lengthSq() < 1e-12) this.orbitVelocity.set(0, 0);
    if (this.lookVelocity.lengthSq() < 1e-12) this.lookVelocity.set(0, 0);
    if (Math.abs(this.tiltVelocity) < 1e-7) this.tiltVelocity = 0;
    if (Math.abs(this.zoomVelocity) < 1e-7) this.zoomVelocity = 0;
  }

  private inputGain(): number {
    return this.enableDamping
      ? THREE.MathUtils.clamp(this.dampingFactor, 0.01, 1)
      : 1;
  }

  private resetVelocities(): void {
    this.orbitVelocity.set(0, 0);
    this.lookVelocity.set(0, 0);
    this.tiltVelocity = 0;
    this.zoomVelocity = 0;
  }
}

function pointerMode(button: number): DragMode | null {
  if (button === 0) return 'globe';
  if (button === 1) return 'tilt';
  if (button === 2) return 'look';
  return null;
}

function normalizeWheelDelta(event: WheelEvent): number {
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? Math.max(1, window.innerHeight)
      : 1;
  return (event.deltaY * unit) / 100;
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function intersectEllipsoid(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  ellipsoid: Ellipsoid
): THREE.Vector3 | null {
  const inverseRadii = new THREE.Vector3(
    1 / ellipsoid.equatorialRadius,
    1 / ellipsoid.polarRadius,
    1 / ellipsoid.equatorialRadius
  );
  const scaledOrigin = origin.clone().multiply(inverseRadii);
  const scaledDirection = direction.clone().multiply(inverseRadii);
  const a = scaledDirection.lengthSq();
  const b = 2 * scaledOrigin.dot(scaledDirection);
  const c = scaledOrigin.lengthSq() - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0 || a <= 0) return null;
  const root = Math.sqrt(discriminant);
  const near = (-b - root) / (2 * a);
  const far = (-b + root) / (2 * a);
  const distance = near >= 0 ? near : far >= 0 ? far : -1;
  return distance >= 0 ? origin.clone().addScaledVector(direction, distance) : null;
}
