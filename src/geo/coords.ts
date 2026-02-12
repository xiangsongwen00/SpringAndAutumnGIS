export type Vec3 = { x: number; y: number; z: number };
export type LonLatHeight = { lon: number; lat: number; height: number };
export type Wgs84OriginInput = LonLatHeight | string;

export type GeoCoordinatorOptions = {
  metersPerUnit?: number;
  frontLonDeg?: number;
  renderOriginThree?: Vec3;
  enuOrigin?: Wgs84OriginInput;
};

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WEB_MERCATOR_R = 6378137.0;
const WEB_MERCATOR_MAX_LAT = 85.05112878;

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function normalizeLonDeg(lon: number): number {
  let out = lon % 360;
  if (out > 180) out -= 360;
  if (out <= -180) out += 360;
  return out;
}

function normalizeMetersPerUnit(value: number | undefined): number {
  const metersPerUnit = value ?? 1;
  if (!Number.isFinite(metersPerUnit) || metersPerUnit <= 0) {
    throw new Error(`Invalid metersPerUnit: ${metersPerUnit}`);
  }
  return metersPerUnit;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len <= 0 || !Number.isFinite(len)) return { x: 0, y: 0, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function clampWebMercatorLat(lat: number): number {
  return Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, lat));
}

function assertWgs84(value: LonLatHeight, context: string): void {
  if (!Number.isFinite(value.lon) || value.lon < -180 || value.lon > 180) {
    throw new Error(`${context}: lon must be in [-180, 180], got ${value.lon}`);
  }
  if (!Number.isFinite(value.lat) || value.lat < -90 || value.lat > 90) {
    throw new Error(`${context}: lat must be in [-90, 90], got ${value.lat}`);
  }
  if (!Number.isFinite(value.height)) {
    throw new Error(`${context}: height must be finite, got ${value.height}`);
  }
}

function parseWgs84Origin(input: string): LonLatHeight {
  const parts = input
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length !== 3) {
    throw new Error(`Invalid origin format. Expected "lon,lat,height", got "${input}"`);
  }

  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  const height = Number(parts[2]);

  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(height)) {
    throw new Error(`Invalid origin numeric values: "${input}"`);
  }

  const origin = { lon, lat, height };
  assertWgs84(origin, 'parseWgs84Origin');
  return origin;
}

function normalizeOrigin(origin: Wgs84OriginInput): LonLatHeight {
  if (typeof origin === 'string') {
    return parseWgs84Origin(origin);
  }

  const normalized = { lon: origin.lon, lat: origin.lat, height: origin.height };
  assertWgs84(normalized, 'normalizeOrigin');
  return normalized;
}

export class GeoCoordinator {
  private _metersPerUnit: number;
  private _frontLonDeg: number;
  private _renderOriginThree: Vec3;
  private _enuOrigin?: LonLatHeight;

  // ECEF basis for three axes.
  private _axisXEcef: Vec3;
  private _axisYEcef: Vec3;
  private _axisZEcef: Vec3;

  constructor(options?: GeoCoordinatorOptions) {
    this._metersPerUnit = normalizeMetersPerUnit(options?.metersPerUnit);
    this._frontLonDeg = normalizeLonDeg(options?.frontLonDeg ?? 0);
    this._renderOriginThree = options?.renderOriginThree
      ? {
          x: options.renderOriginThree.x,
          y: options.renderOriginThree.y,
          z: options.renderOriginThree.z
        }
      : { x: 0, y: 0, z: 0 };

    this._axisXEcef = { x: 1, y: 0, z: 0 };
    this._axisYEcef = { x: 0, y: 0, z: 1 };
    this._axisZEcef = { x: 0, y: 1, z: 0 };
    this.rebuildAxes();

    if (options?.enuOrigin !== undefined) {
      this._enuOrigin = normalizeOrigin(options.enuOrigin);
    }
  }

  get metersPerUnit(): number {
    return this._metersPerUnit;
  }

  setMetersPerUnit(metersPerUnit: number): void {
    this._metersPerUnit = normalizeMetersPerUnit(metersPerUnit);
  }

  get frontLonDeg(): number {
    return this._frontLonDeg;
  }

  setFrontLonDeg(frontLonDeg: number): void {
    if (!Number.isFinite(frontLonDeg)) {
      throw new Error(`Invalid frontLonDeg: ${frontLonDeg}`);
    }
    this._frontLonDeg = normalizeLonDeg(frontLonDeg);
    this.rebuildAxes();
  }

  get renderOriginThree(): Vec3 {
    return { x: this._renderOriginThree.x, y: this._renderOriginThree.y, z: this._renderOriginThree.z };
  }

  setRenderOriginThree(origin: Vec3): Vec3 {
    this._renderOriginThree = { x: origin.x, y: origin.y, z: origin.z };
    return this.renderOriginThree;
  }

  worldToRender(threeWorld: Vec3): Vec3 {
    return {
      x: threeWorld.x - this._renderOriginThree.x,
      y: threeWorld.y - this._renderOriginThree.y,
      z: threeWorld.z - this._renderOriginThree.z
    };
  }

  renderToWorld(render: Vec3): Vec3 {
    return {
      x: render.x + this._renderOriginThree.x,
      y: render.y + this._renderOriginThree.y,
      z: render.z + this._renderOriginThree.z
    };
  }

  get enuOrigin(): LonLatHeight | undefined {
    return this._enuOrigin;
  }

  setEnuOrigin(origin: Wgs84OriginInput): LonLatHeight {
    const normalized = normalizeOrigin(origin);
    this._enuOrigin = normalized;
    return normalized;
  }

  clearEnuOrigin(): void {
    this._enuOrigin = undefined;
  }

  resolveEnuOrigin(originInput?: Wgs84OriginInput, cameraThreePosition?: Vec3): LonLatHeight {
    if (originInput !== undefined) {
      return this.setEnuOrigin(originInput);
    }
    if (this._enuOrigin !== undefined) {
      return this._enuOrigin;
    }
    if (cameraThreePosition !== undefined) {
      const world = this.renderToWorld(cameraThreePosition);
      const origin = this.threeToWgs84(world);
      this._enuOrigin = origin;
      return origin;
    }
    throw new Error('ENU origin is not set. Provide WGS84 origin or camera position.');
  }

  getThreeAxesInEcef(): { x: Vec3; y: Vec3; z: Vec3 } {
    return {
      x: { ...this._axisXEcef },
      y: { ...this._axisYEcef },
      z: { ...this._axisZEcef }
    };
  }

  earthRadiusInThreeUnits(): number {
    return WGS84_A / this._metersPerUnit;
  }

  wgs84ToEcef(lat: number, lon: number, height = 0): Vec3 {
    const latRad = degToRad(lat);
    const lonRad = degToRad(lon);
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);

    return {
      x: (n + height) * cosLat * cosLon,
      y: (n + height) * cosLat * sinLon,
      z: (n * (1 - WGS84_E2) + height) * sinLat
    };
  }

  ecefToWgs84(x: number, y: number, z: number): LonLatHeight {
    const p = Math.sqrt(x * x + y * y);
    const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const ePrime2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);

    const lon = Math.atan2(y, x);
    const lat = Math.atan2(
      z + ePrime2 * WGS84_B * sinTheta * sinTheta * sinTheta,
      p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta
    );

    const sinLat = Math.sin(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const height = p / Math.cos(lat) - n;

    return {
      lon: radToDeg(lon),
      lat: radToDeg(lat),
      height
    };
  }

  // Contract: +Y north pole, +Z faces (frontLonDeg, 0), +X east on that front face.
  ecefToThree(ecef: Vec3): Vec3 {
    return {
      x: dot(ecef, this._axisXEcef) / this._metersPerUnit,
      y: dot(ecef, this._axisYEcef) / this._metersPerUnit,
      z: dot(ecef, this._axisZEcef) / this._metersPerUnit
    };
  }

  threeToEcef(three: Vec3): Vec3 {
    const sx = scale(this._axisXEcef, three.x * this._metersPerUnit);
    const sy = scale(this._axisYEcef, three.y * this._metersPerUnit);
    const sz = scale(this._axisZEcef, three.z * this._metersPerUnit);
    return add(add(sx, sy), sz);
  }

  wgs84ToThree(lat: number, lon: number, height: number): Vec3 {
    return this.ecefToThree(this.wgs84ToEcef(lat, lon, height));
  }

  threeToWgs84(three: Vec3): LonLatHeight {
    const ecef = this.threeToEcef(three);
    return this.ecefToWgs84(ecef.x, ecef.y, ecef.z);
  }

  ecefToEnu(ecef: Vec3, originInput?: Wgs84OriginInput): Vec3 {
    const origin = this.resolveEnuOrigin(originInput);
    const originEcef = this.wgs84ToEcef(origin.lat, origin.lon, origin.height);

    const latRad = degToRad(origin.lat);
    const lonRad = degToRad(origin.lon);
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    const dx = ecef.x - originEcef.x;
    const dy = ecef.y - originEcef.y;
    const dz = ecef.z - originEcef.z;

    return {
      x: -sinLon * dx + cosLon * dy,
      y: -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
      z: cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz
    };
  }

  enuToEcef(enu: Vec3, originInput?: Wgs84OriginInput): Vec3 {
    const origin = this.resolveEnuOrigin(originInput);
    const originEcef = this.wgs84ToEcef(origin.lat, origin.lon, origin.height);

    const latRad = degToRad(origin.lat);
    const lonRad = degToRad(origin.lon);
    const sinLat = Math.sin(latRad);
    const cosLat = Math.cos(latRad);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);

    const dx = -sinLon * enu.x - sinLat * cosLon * enu.y + cosLat * cosLon * enu.z;
    const dy = cosLon * enu.x - sinLat * sinLon * enu.y + cosLat * sinLon * enu.z;
    const dz = cosLat * enu.y + sinLat * enu.z;

    return {
      x: originEcef.x + dx,
      y: originEcef.y + dy,
      z: originEcef.z + dz
    };
  }

  wgs84ToEnu(lat: number, lon: number, height: number, originInput?: Wgs84OriginInput): Vec3 {
    return this.ecefToEnu(this.wgs84ToEcef(lat, lon, height), originInput);
  }

  enuToWgs84(enu: Vec3, originInput?: Wgs84OriginInput): LonLatHeight {
    const ecef = this.enuToEcef(enu, originInput);
    return this.ecefToWgs84(ecef.x, ecef.y, ecef.z);
  }

  lonLatToWebMercator(lon: number, lat: number): { x: number; y: number } {
    const clampedLat = clampWebMercatorLat(lat);
    return {
      x: WEB_MERCATOR_R * degToRad(lon),
      y: WEB_MERCATOR_R * Math.log(Math.tan(Math.PI / 4 + degToRad(clampedLat) / 2))
    };
  }

  webMercatorToLonLat(x: number, y: number): { lon: number; lat: number } {
    return {
      lon: radToDeg(x / WEB_MERCATOR_R),
      lat: radToDeg(2 * Math.atan(Math.exp(y / WEB_MERCATOR_R)) - Math.PI / 2)
    };
  }

  lonLatToTile(lon: number, lat: number, zoom: number): { x: number; y: number } {
    const clampedLat = clampWebMercatorLat(lat);
    const latRad = degToRad(clampedLat);
    const n = 2 ** zoom;

    return {
      x: Math.floor(((lon + 180) / 360) * n),
      y: Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
    };
  }

  tileToLonLat(x: number, y: number, zoom: number): { lon: number; lat: number } {
    const n = 2 ** zoom;
    const lon = (x / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    return { lon, lat: radToDeg(latRad) };
  }

  private rebuildAxes(): void {
    const lonRad = degToRad(this._frontLonDeg);
    const cosLon = Math.cos(lonRad);
    const sinLon = Math.sin(lonRad);

    const zAxis: Vec3 = { x: cosLon, y: sinLon, z: 0 };
    const yAxis: Vec3 = { x: 0, y: 0, z: 1 };
    const xAxis: Vec3 = { x: -sinLon, y: cosLon, z: 0 };

    this._axisXEcef = normalize(xAxis);
    this._axisYEcef = normalize(yAxis);
    this._axisZEcef = normalize(zAxis);
  }
}
