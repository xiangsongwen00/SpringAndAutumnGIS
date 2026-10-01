import * as THREE from 'three';
import { Ellipsoid } from '../core/geo/Ellipsoid';
import type { SelectedTile } from '../core/lod/GlobeLodSelector';
import { tileKey, type TileId } from '../core/tiling/GeographicTilingScheme';
import { VectorDecodeService } from '../vector/worker/VectorDecodeService';
import { MvtTileSource } from '../vector/source/MvtTileSource';
import { MapStyleLoader } from '../vector/style/MapStyleLoader';
import { VectorStyleRuntime } from '../vector/style/VectorStyleRuntime';
import { bindVectorTerrain, vectorTerrainShader, vectorTerrainUniforms } from '../vector/terrain/VectorTerrainBinding';
import {
  ancestorAtLevel, buildBackgroundGeometry, buildFillGeometry, buildLineGeometry,
  buildPointGeometry, firstPoint, webMercatorTileBounds, type GeometryBuilder
} from '../vector/bucket/VectorGeometryBuilder';
export { geographicDegreesToShaderRadians } from '../vector/bucket/VectorGeometryBuilder';
import type {
  DecodedFeature,
  MapStyle,
  StyleLayer,
  VectorSource
} from '../vector/style/VectorStyleTypes';
import { globeCoordinateShader } from './shaders/coordinates';
import type { TerrainHeightSource } from './TerrainTileLayer';

export type MvtVectorLayerOptions = Readonly<{
  id: string;
  urlTemplate?: string;
  tileJsonUrl?: string;
  styleUrl?: string;
  style?: MapStyle;
  sourceId?: string;
  scheme?: 'xyz' | 'tms';
  subdomains?: readonly string[];
  minLevel?: number;
  maxLevel?: number;
  levelOffset?: number;
  bounds?: readonly [number, number, number, number];
  opacity?: number;
  order?: number;
  maxConcurrentRequests?: number;
  maxCachedTiles?: number;
  heightOffset?: number;
  terrain?: TerrainHeightSource;
  terrainSampleBudget?: number;
  maxLabelsPerTile?: number;
  maxVisibleLabels?: number;
  /** Surface backgrounds are enabled for base maps, disabled for overlays. */
  role?: 'base' | 'overlay';
  symbols?: boolean;
  fetcher?: typeof fetch;
}>;

export type MvtVectorLayerStats = Readonly<{
  sourceLevel: number;
  ready: number;
  loading: number;
  queued: number;
  errors: number;
  visible: number;
  allocatedLabels: number;
  visibleLabels: number;
}>;

type TileState = 'queued' | 'loading' | 'ready' | 'error';
type TileRecord = {
  id: TileId;
  key: string;
  state: TileState;
  priority: number;
  lastUsedFrame: number;
  group: THREE.Group | null;
  controller: AbortController | null;
  error: string | null;
  labels: LabelState[];
};
type LabelState = {
  longitude: number;
  latitude: number;
  sprite: THREE.Sprite;
  pixelWidth: number;
  pixelHeight: number;
};
/** Native GPU rendering path for tiled MVT fill/line/circle geometry and 3D labels. */
export class MvtVectorLayer {
  readonly object3d = new THREE.Group();
  readonly id: string;

  private readonly ellipsoid: Ellipsoid;
  private readonly styleLoader: MapStyleLoader;
  private readonly directSource?: VectorSource;
  private readonly decoder = new VectorDecodeService();
  private readonly terrain?: TerrainHeightSource;
  private readonly minLevel: number;
  private readonly maxLevel: number;
  private levelOffset: number;
  private readonly role: 'base' | 'overlay';
  private readonly symbols: boolean;
  private readonly maxConcurrentRequests: number;
  private readonly maxCachedTiles: number;
  private readonly maxLabelsPerTile: number;
  private readonly maxVisibleLabels: number;
  private readonly heightOffset: number;
  private readonly order: number;
  private readonly bounds?: readonly [number, number, number, number];
  private readonly fetcher?: typeof fetch;
  private readonly records = new Map<string, TileRecord>();
  private readonly queue: TileRecord[] = [];
  private style: MapStyle | null = null;
  private styleRuntime: VectorStyleRuntime | null = null;
  private sourceId = '';
  private source: MvtTileSource | null = null;
  private sourceLayers = new Set<string>();
  private activeRequests = 0;
  private frame = 0;
  private currentSourceLevel = 0;
  private layerOpacity: number;
  private observedTerrainRevision = -1;
  private readonly labelNormal = new THREE.Vector3();
  private readonly labelToCamera = new THREE.Vector3();
  private disposed = false;

  constructor(ellipsoid: Ellipsoid, options: MvtVectorLayerOptions) {
    this.ellipsoid = ellipsoid;
    this.id = options.id;
    this.minLevel = Math.max(0, Math.round(options.minLevel ?? 0));
    this.maxLevel = Math.max(this.minLevel, Math.round(options.maxLevel ?? 20));
    this.levelOffset = THREE.MathUtils.clamp(options.levelOffset ?? -1.7, -8, 2);
    this.role = options.role ?? 'overlay';
    this.symbols = options.symbols ?? this.role === 'overlay';
    this.maxConcurrentRequests = Math.max(1, Math.round(options.maxConcurrentRequests ?? 6));
    this.maxCachedTiles = Math.max(16, Math.round(options.maxCachedTiles ?? 256));
    this.maxLabelsPerTile = Math.max(0, Math.round(options.maxLabelsPerTile ?? 12));
    this.maxVisibleLabels = Math.max(0, Math.round(options.maxVisibleLabels ?? 48));
    this.heightOffset = Math.max(0, options.heightOffset ?? (this.role === 'base' ? 0.1 : 3));
    this.order = options.order ?? 300;
    this.bounds = options.bounds;
    this.terrain = options.terrain;
    this.fetcher = options.fetcher;
    this.layerOpacity = THREE.MathUtils.clamp(options.opacity ?? 1, 0, 1);
    this.styleLoader = new MapStyleLoader({
      styleUrl: options.styleUrl,
      style: options.style,
      sourceId: options.sourceId,
      fetcher: options.fetcher
    });
    this.directSource = options.urlTemplate || options.tileJsonUrl
      ? {
          type: 'vector',
          tiles: options.urlTemplate ? [options.urlTemplate] : undefined,
          url: options.tileJsonUrl,
          minzoom: this.minLevel,
          maxzoom: this.maxLevel,
          scheme: options.scheme,
          subdomains: options.subdomains
        }
      : undefined;
    this.object3d.renderOrder = this.order;
  }

  async initialize(): Promise<void> {
    if (this.style && this.source) return;
    const style = await this.styleLoader.load();
    const selected = this.styleLoader.selectVectorSource(style);
    this.style = style;
    this.styleRuntime = new VectorStyleRuntime(style);
    if (this.styleRuntime.issues.length) console.warn(`[MVT ${this.id}] 样式编译诊断`, this.styleRuntime.issues);
    this.sourceId = selected.id;
    this.sourceLayers = new Set(this.styleLoader.sourceLayerNames(style, selected.id));
    this.source = new MvtTileSource({
      id: selected.id,
      source: this.directSource ?? selected.source,
      fetcher: this.fetcher
    });
  }

  get stats(): MvtVectorLayerStats {
    const counts = { ready: 0, loading: 0, queued: 0, errors: 0 };
    let visible = 0;
    let allocatedLabels = 0;
    let visibleLabels = 0;
    for (const record of this.records.values()) {
      if (record.state === 'error') counts.errors += 1;
      else counts[record.state] += 1;
      if (record.group?.visible) visible += 1;
      allocatedLabels += record.labels.length;
      visibleLabels += record.labels.filter((label) => label.sprite.visible && record.group?.visible).length;
    }
    return {
      ...counts,
      visible,
      allocatedLabels,
      visibleLabels,
      sourceLevel: this.currentSourceLevel
    };
  }

  update(
    selection: readonly SelectedTile[],
    cameraLevel: number,
    camera: THREE.PerspectiveCamera,
    viewportWidth: number,
    viewportHeight: number
  ): void {
    if (this.disposed || !this.style || !this.source) return;
    this.frame += 1;
    this.currentSourceLevel = THREE.MathUtils.clamp(
      Math.floor(cameraLevel + this.levelOffset + 1e-9),
      this.minLevel,
      this.maxLevel
    );
    const desired = new Map<string, { id: TileId; priority: number }>();
    for (const selected of selection) {
      const id = ancestorAtLevel(selected.id, Math.min(selected.id.level, this.currentSourceLevel));
      if (!this.hasTile(id)) continue;
      const key = tileKey(id);
      const current = desired.get(key);
      const priority = selected.viewCenterDistance * 1_000_000 - selected.screenPixels;
      if (!current || priority < current.priority) desired.set(key, { id, priority });
    }
    const visible = new Set<string>();
    for (const { id, priority } of desired.values()) {
      const key = tileKey(id);
      let record = this.records.get(key);
      if (!record) {
        record = {
          id, key, state: 'queued', priority, lastUsedFrame: this.frame,
          group: null, controller: null, error: null, labels: []
        };
        this.records.set(key, record);
        this.queue.push(record);
      } else {
        record.priority = priority;
        record.lastUsedFrame = this.frame;
      }
      if (record.state === 'ready') visible.add(key);
      else {
        const ancestor = this.readyAncestor(id);
        if (ancestor) {
          ancestor.lastUsedFrame = this.frame;
          visible.add(ancestor.key);
        }
      }
    }
    for (const [key, record] of this.records) {
      if (record.lastUsedFrame === this.frame) continue;
      if (record.state === 'queued' || record.state === 'loading') {
        record.controller?.abort();
        record.state = 'error';
        this.records.delete(key);
      }
    }
    for (const record of this.records.values()) {
      if (record.group) record.group.visible = visible.has(record.key);
      if (record.group?.visible) record.group.traverse((object) => {
        const material = (object as THREE.Mesh).material;
        if (material instanceof THREE.ShaderMaterial) bindVectorTerrain(material, record.id, this.terrain);
      });
    }
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pumpQueue();
    // Geometry samples the shared DEM on the GPU. Only symbol anchors need CPU height queries.
    if (this.terrain?.revision !== this.observedTerrainRevision) {
      for (const record of this.records.values()) for (const label of record.labels) {
        this.positionLabel(label.sprite, label.longitude, label.latitude);
      }
      this.observedTerrainRevision = this.terrain?.revision ?? -1;
    }
    this.updateLabels(camera, viewportWidth, viewportHeight);
    this.evict();
  }

  setOpacity(opacity: number): void {
    this.layerOpacity = THREE.MathUtils.clamp(opacity, 0, 1);
    this.object3d.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      const materials = material ? Array.isArray(material) ? material : [material] : [];
      for (const candidate of materials) {
        if (candidate instanceof THREE.ShaderMaterial && candidate.uniforms.opacity) {
          candidate.uniforms.opacity.value =
            Number(candidate.userData.styleOpacity ?? 1) * this.layerOpacity;
        }
      }
    });
    for (const record of this.records.values()) {
      for (const label of record.labels) label.sprite.material.opacity = this.layerOpacity;
    }
  }

  setViewLevelOffset(offset: number): void {
    if (Number.isFinite(offset)) this.levelOffset = THREE.MathUtils.clamp(offset, -8, 2);
  }

  get styleIssues() { return this.styleRuntime?.issues ?? []; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.decoder.dispose();
    for (const record of this.records.values()) this.disposeRecord(record);
    this.records.clear();
    this.queue.length = 0;
    this.object3d.clear();
  }

  private pumpQueue(): void {
    while (this.activeRequests < this.maxConcurrentRequests) {
      const record = this.queue.shift();
      if (!record) break;
      if (record.state !== 'queued') continue;
      record.state = 'loading';
      record.controller = new AbortController();
      this.activeRequests += 1;
      void this.loadRecord(record).finally(() => {
        record.controller = null;
        this.activeRequests = Math.max(0, this.activeRequests - 1);
        this.pumpQueue();
      });
    }
  }

  private async loadRecord(record: TileRecord): Promise<void> {
    try {
      const bytes = await this.source!.load(record.id, record.controller?.signal);
      if (this.disposed || record.controller?.signal.aborted) return;
      const decoded = await this.decoder.decode(bytes, this.sourceLayers);
      if (this.disposed || record.controller?.signal.aborted) return;
      const built = this.buildTile(record.id, decoded);
      record.group = built.group;
      record.labels = built.labels;
      record.group.visible = false;
      this.object3d.add(record.group);
      record.state = 'ready';
      record.error = null;
    } catch (error) {
      if (record.controller?.signal.aborted) return;
      record.state = 'error';
      record.error = error instanceof Error ? error.message : String(error);
      console.error(`[MVT ${this.id}] ${record.key} 加载失败`, error);
    }
  }

  private buildTile(id: TileId, decoded: ReadonlyMap<string, readonly DecodedFeature[]>) {
    const group = new THREE.Group();
    group.renderOrder = this.order;
    const labels: LabelState[] = [];
    const labelTexts = new Set<string>();
    const types = new Set(['background', 'fill', 'line', 'circle']);
    if (this.symbols) types.add('symbol');
    for (const bucket of this.styleRuntime!.buckets(decoded, this.sourceId, id.level, types)) {
      const { layer, features, order } = bucket;
      const renderOrder = this.order + order * 0.001;
      if (layer.type === 'background' && this.role === 'base') {
        const state = this.createGeometry(buildBackgroundGeometry(id));
        const mesh = new THREE.Mesh(state.geometry, this.createMaterial(
          colorStyle(layer.paint?.['background-color'], '#a7d6fe'),
          numberStyle(layer.paint?.['background-opacity'], 1), 'fill'
        ));
        configureObject(mesh, renderOrder);
        group.add(mesh);
      }
      if (features.length === 0) continue;
      if (layer.type === 'fill') {
        const built = buildFillGeometry(id, features);
        if (built.indices.length === 0) continue;
        const state = this.createGeometry(built);
        const opacity = numberStyle(layer.paint?.['fill-opacity'], 1);
        const material = this.createMaterial(
          colorStyle(layer.paint?.['fill-color'], '#42b8d8'), opacity, 'fill'
        );
        const mesh = new THREE.Mesh(state.geometry, material);
        configureObject(mesh, renderOrder);
        group.add(mesh);
        const outline = layer.paint?.['fill-outline-color'];
        if (outline !== undefined) {
          const outlineState = this.createGeometry(buildLineGeometry(id, features));
          const outlineMaterial = this.createMaterial(
            colorStyle(outline, '#1b5f73'), Math.min(1, opacity + 0.25), 'line'
          );
          const outlineLines = new THREE.LineSegments(outlineState.geometry, outlineMaterial);
          configureObject(outlineLines, renderOrder + 0.0001);
          group.add(outlineLines);
        }
      } else if (layer.type === 'line') {
        const built = buildLineGeometry(id, features);
        if (built.positions.length === 0) continue;
        const state = this.createGeometry(built);
        const opacity = numberStyle(layer.paint?.['line-opacity'], 1);
        const material = this.createMaterial(
          colorStyle(layer.paint?.['line-color'], '#1b5f73'), opacity, 'line'
        );
        const lines = new THREE.LineSegments(state.geometry, material);
        configureObject(lines, renderOrder);
        group.add(lines);
      } else if (layer.type === 'circle') {
        const built = buildPointGeometry(id, features);
        if (built.positions.length === 0) continue;
        const state = this.createGeometry(built);
        const opacity = numberStyle(layer.paint?.['circle-opacity'], 1);
        const material = this.createMaterial(
          colorStyle(layer.paint?.['circle-color'], '#36c5f0'), opacity, 'point',
          numberStyle(layer.paint?.['circle-radius'], 4) * 2
        );
        const points = new THREE.Points(state.geometry, material);
        configureObject(points, renderOrder);
        group.add(points);
      } else if (layer.type === 'symbol' && this.symbols) {
        for (const feature of features) {
          if (labels.length >= this.maxLabelsPerTile) break;
          const text = resolveText(layer.layout?.['text-field'], feature.properties);
          const point = firstPoint(id, feature);
          if (!text || !point || labelTexts.has(text)) continue;
          const label = this.createLabel(text, point[0], point[1], layer);
          group.add(label.sprite);
          labels.push(label);
          labelTexts.add(text);
        }
      }
    }
    return { group, labels };
  }

  private createGeometry(builder: GeometryBuilder) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(builder.positions, 3));
    geometry.setAttribute('terrainUv', new THREE.Float32BufferAttribute(builder.uvs, 2));
    if (builder.indices.length > 0) geometry.setIndex(builder.indices);
    geometry.computeBoundingSphere();
    return { geometry };
  }

  private createMaterial(
    color: THREE.ColorRepresentation,
    styleOpacity: number,
    primitive: 'fill' | 'line' | 'point',
    pointSize = 1
  ): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...vectorTerrainUniforms(),
        sag_ellipsoidRadii: { value: new THREE.Vector2(this.ellipsoid.equatorialRadius, this.ellipsoid.polarRadius) },
        sag_heightOffset: { value: this.heightOffset },
        sag_cameraHigh: { value: new THREE.Vector3() },
        sag_cameraLow: { value: new THREE.Vector3() },
        color: { value: new THREE.Color(color) },
        opacity: { value: styleOpacity * this.layerOpacity },
        pointSize: { value: pointSize }
      },
      vertexShader: /* glsl */ `
        uniform float pointSize;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        ${globeCoordinateShader}
        ${vectorTerrainShader}
        varying vec2 v_tileUv;
        void main() {
          v_tileUv = terrainUv;
          gl_Position = sag_projectGeodetic(position.xy, vectorElevation());
          gl_PointSize = pointSize;
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 color;
        uniform float opacity;
        varying vec2 v_tileUv;
        #include <logdepthbuf_pars_fragment>
        void main() {
          if (v_tileUv.x < 0.0 || v_tileUv.x > 1.0 || v_tileUv.y < 0.0 || v_tileUv.y > 1.0) discard;
          ${primitive === 'point' ? 'if (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;' : ''}
          gl_FragColor = vec4(color, opacity);
          #include <logdepthbuf_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: primitive === 'fill' ? THREE.DoubleSide : THREE.FrontSide,
      toneMapped: false
    });
    material.userData.primitive = primitive;
    material.userData.styleOpacity = styleOpacity;
    return material;
  }

  private createLabel(text: string, longitude: number, latitude: number, layer: StyleLayer): LabelState {
    const fontSize = Math.max(10, numberStyle(layer.layout?.['text-size'], 12));
    const padding = 4;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    context.font = `600 ${fontSize}px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
    const width = Math.ceil(context.measureText(text).width + padding * 2);
    const height = Math.ceil(fontSize * 1.5 + padding * 2);
    canvas.width = Math.max(2, width);
    canvas.height = Math.max(2, height);
    context.font = `600 ${fontSize}px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.strokeStyle = colorStyle(layer.paint?.['text-halo-color'], '#ffffff');
    context.lineWidth = Math.max(2, numberStyle(layer.paint?.['text-halo-width'], 1) * 2);
    context.strokeText(text, canvas.width / 2, canvas.height / 2);
    context.fillStyle = colorStyle(layer.paint?.['text-color'], '#153746');
    context.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      // Labels are screen-facing billboards whose world-space size changes to
      // remain pixel-stable. Terrain depth would slice through their glyphs;
      // horizon visibility is handled explicitly in updateLabels instead.
      depthTest: false,
      depthWrite: false,
      opacity: this.layerOpacity,
      toneMapped: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.center.set(0.5, 0);
    sprite.renderOrder = this.order + 10;
    sprite.frustumCulled = false;
    this.positionLabel(sprite, longitude, latitude);
    return { longitude, latitude, sprite, pixelWidth: canvas.width, pixelHeight: canvas.height };
  }

  private positionLabel(sprite: THREE.Sprite, longitude: number, latitude: number): void {
    const terrainHeight = this.terrain?.enabled
      ? this.terrain.sampleHeight(longitude, latitude) ?? 0
      : 0;
    this.ellipsoid.cartographicToCartesian(
      { longitude, latitude, height: terrainHeight + this.heightOffset + 20 },
      sprite.position
    );
  }


  private updateLabels(
    camera: THREE.PerspectiveCamera,
    viewportWidth: number,
    viewportHeight: number
  ): void {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const occupied: Array<readonly [number, number, number, number]> = [];
    const projected = new THREE.Vector3();
    const records = [...this.records.values()].sort((left, right) => left.priority - right.priority);
    for (const record of records) {
      const labelsAllowed = record.group?.visible && record.id.level === this.currentSourceLevel;
      for (const label of record.labels) {
        if (!labelsAllowed || occupied.length >= this.maxVisibleLabels) {
          label.sprite.visible = false;
          continue;
        }
        const distance = Math.max(1, camera.position.distanceTo(label.sprite.position));
        const worldPerPixel = 2 * distance * Math.tan(fov / 2) / Math.max(1, viewportHeight);
        label.sprite.scale.set(
          label.pixelWidth * worldPerPixel,
          label.pixelHeight * worldPerPixel,
          1
        );
        projected.copy(label.sprite.position).project(camera);
        const x = (projected.x * 0.5 + 0.5) * viewportWidth;
        const y = (-projected.y * 0.5 + 0.5) * viewportHeight;
        const box: readonly [number, number, number, number] = [
          x - label.pixelWidth * 0.5 - 2,
          y - label.pixelHeight - 2,
          x + label.pixelWidth * 0.5 + 2,
          y + 2
        ];
        const outside = projected.z < -1 || projected.z > 1 ||
          box[2] < 0 || box[0] > viewportWidth || box[3] < 0 || box[1] > viewportHeight;
        const longitude = THREE.MathUtils.degToRad(label.longitude);
        const latitude = THREE.MathUtils.degToRad(label.latitude);
        this.labelNormal.set(
          Math.cos(latitude) * Math.sin(longitude),
          Math.sin(latitude),
          Math.cos(latitude) * Math.cos(longitude)
        );
        this.labelToCamera.copy(camera.position).sub(label.sprite.position);
        const behindHorizon = this.labelNormal.dot(this.labelToCamera) <= 0;
        const collided = occupied.some((other) => rectanglesOverlap(box, other));
        label.sprite.visible = !outside && !behindHorizon && !collided;
        if (label.sprite.visible) occupied.push(box);
      }
    }
  }

  private readyAncestor(id: TileId): TileRecord | undefined {
    for (let level = id.level - 1; level >= this.minLevel; level -= 1) {
      const candidate = this.records.get(tileKey(ancestorAtLevel(id, level)));
      if (candidate?.state === 'ready') return candidate;
    }
    return undefined;
  }

  private hasTile(id: TileId): boolean {
    if (!this.bounds) return true;
    const [west, south, east, north] = webMercatorTileBounds(id);
    const [boundsWest, boundsSouth, boundsEast, boundsNorth] = this.bounds;
    const latitudeIntersects = south < boundsNorth && north > boundsSouth;
    const longitudeIntersects = boundsWest <= boundsEast
      ? west < boundsEast && east > boundsWest
      : west < boundsEast || east > boundsWest;
    return latitudeIntersects && longitudeIntersects;
  }

  private evict(): void {
    if (this.records.size <= this.maxCachedTiles) return;
    const candidates = [...this.records.values()]
      .filter((record) => record.state !== 'loading' && !record.group?.visible)
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    while (this.records.size > this.maxCachedTiles) {
      const record = candidates.shift();
      if (!record) break;
      this.disposeRecord(record);
      this.records.delete(record.key);
    }
  }

  private disposeRecord(record: TileRecord): void {
    record.controller?.abort();
    if (!record.group) return;
    record.group.traverse((object) => {
      const renderable = object as THREE.Mesh;
      const geometry = renderable.geometry as THREE.BufferGeometry | undefined;
      geometry?.dispose();
      const materials = renderable.material
        ? Array.isArray(renderable.material) ? renderable.material : [renderable.material]
        : [];
      for (const material of materials) {
        if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
        material.dispose();
      }
    });
    this.object3d.remove(record.group);
  }
}


function styleLayerVisible(layer: StyleLayer, zoom: number, sourceId: string): boolean {
  return layer.layout?.visibility !== 'none' &&
    (!layer.source || layer.source === sourceId) &&
    (layer.minzoom === undefined || zoom >= layer.minzoom) &&
    (layer.maxzoom === undefined || zoom < layer.maxzoom);
}

function numberStyle(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function colorStyle(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function resolveText(value: unknown, properties: Record<string, number | string | boolean>): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\{([^}]+)\}/g, (_match, key: string) => String(properties[key] ?? ''));
}

function configureObject(object: THREE.Object3D, order: number): void {
  object.renderOrder = order;
  object.frustumCulled = false;
  object.onBeforeRender = (_renderer, _scene, camera) => {
    const material = (object as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (!material?.uniforms.sag_cameraHigh || !material.uniforms.sag_cameraLow) return;
    splitVector3(camera.position, material.uniforms.sag_cameraHigh.value, material.uniforms.sag_cameraLow.value);
  };
}

function splitVector3(value: THREE.Vector3, high: THREE.Vector3, low: THREE.Vector3): void {
  high.set(Math.fround(value.x), Math.fround(value.y), Math.fround(value.z));
  low.set(value.x - high.x, value.y - high.y, value.z - high.z);
}

function rectanglesOverlap(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}
