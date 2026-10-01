import * as THREE from 'three';
import { PbfWriter } from 'pbf';
import { GpuVectorTileProvider } from '../src/core/tiles/GpuVectorTileProvider';
import type { MapStyle } from '../src/vector/style/VectorStyleTypes';
import { RasterTileLayer } from '../src/render/RasterTileLayer';
import { UrlTemplateRasterProvider } from '../src/core/tiles/RasterTileProvider';
import { Ellipsoid } from '../src/core/geo/Ellipsoid';
import { WebMercatorTilingScheme } from '../src/core/tiling/WebMercatorTilingScheme';
import { MvtVectorLayer } from '../src/render/MvtVectorLayer';
import { TerrainDecodeService } from '../src/core/terrain/TerrainDecodeService';
import { convertTerrainPixels } from '../src/core/terrain/TerrainHeightConversion';
import { VectorSurfaceService } from '../src/vector/worker/VectorSurfaceService';
import { VectorNativeService } from '../src/vector/worker/VectorNativeService';
import type { SurfacePlan } from '../src/vector/worker/VectorSurfaceBuild';
import type { DecodedVectorTile } from '../src/vector/style/VectorStyleTypes';
import { SerialWorkerClient } from '../src/core/workers/SerialWorkerClient';

// Actual PBF -> worker -> style -> GPU -> surface sampling. North red, south green.
const result = document.querySelector('#result')!;
const failures: string[] = [];
const originalError = console.error;
console.error = (...args) => { failures.push(args.join(' ')); originalError(...args); };
const check = (value: boolean, message: string) => { if (!value) throw new Error(message); };
const zigzag = (value: number) => value < 0 ? -value * 2 - 1 : value * 2;
const writer = new PbfWriter();
writer.writeMessage(3, (_, layer) => {
  layer.writeStringField(1, 'halves');
  layer.writeStringField(3, 'half');
  for (const name of ['north', 'south']) layer.writeMessage(4, (value, pbf) => pbf.writeStringField(1, value), name);
  for (const half of [0, 1]) layer.writeMessage(2, (value, feature) => {
    feature.writeVarintField(1, value + 1);
    feature.writePackedVarint(2, [0, value]);
    feature.writeVarintField(3, 3);
    feature.writePackedVarint(4, [9, 0, zigzag(value * 2048), 26,
      zigzag(4096), 0, 0, zigzag(2048), zigzag(-4096), 0, 15]);
  }, half);
  layer.writeMessage(2, (_, feature) => {
    feature.writeVarintField(3, 2);
    feature.writePackedVarint(4, [9, 0, zigzag(2560), 10, zigzag(4096), 0]);
  }, null);
  layer.writeVarintField(5, 4096);
  layer.writeVarintField(15, 2);
}, null);
const bytes = writer.finish();
const renderer = new THREE.WebGLRenderer();
renderer.setSize(128, 128);
document.body.append(renderer.domElement);
const target = new THREE.WebGLRenderTarget(128, 128);
const stateTarget = new THREE.WebGLRenderTarget(16, 16);
const scene = new THREE.Scene();
const camera = new THREE.Camera();
const material = new THREE.ShaderMaterial({
  uniforms: { map: { value: null }, crop: { value: new THREE.Vector4(1, 1, 0, 0) } },
  vertexShader: 'varying vec2 xyzUv; void main(){xyzUv=vec2(uv.x,1.0-uv.y);gl_Position=vec4(position.xy,0.0,1.0);}',
  // Exact common terrain surface texture convention, including parent crop.
  fragmentShader: 'uniform sampler2D map; uniform vec4 crop; varying vec2 xyzUv; void main(){vec2 p=xyzUv*crop.xy+crop.zw;gl_FragColor=texture2D(map,vec2(p.x,1.0-p.y));}',
  depthTest: false, depthWrite: false
});
const geometry = new THREE.PlaneGeometry(2, 2);
scene.add(new THREE.Mesh(geometry, material));
const pixels = new Uint8Array(128 * 128 * 4);
try {
  // Deterministic queue lifecycle: cancelled work must never clone a queued
  // payload, publish a stale active result, or restart a worker storm.
  const posted: Array<{ id: number }> = [];
  let terminated = false;
  const fake = { onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null, onmessageerror: null,
    postMessage: (message: { id: number }) => posted.push(message),
    terminate: () => { terminated = true; } };
  const rpc = new SerialWorkerClient(() => fake as unknown as Worker, 2);
  const activeAbort = new AbortController(), queuedAbort = new AbortController();
  let cloned = false;
  const active = rpc.request({ job: 'active' }, activeAbort.signal).then(() => false, () => true);
  const queued = rpc.request(() => { cloned = true; return { job: 'queued' }; }, queuedAbort.signal).then(() => false, () => true);
  check(await rpc.request({ job: 'overflow' }).then(() => false, () => true), 'worker queue must apply bounded backpressure');
  queuedAbort.abort(); activeAbort.abort();
  check(await active && await queued && !cloned && posted.length === 1 && rpc.pending === 1,
    'queued abort removes un-cloned payload; active abort waits for physical completion');
  const next = rpc.request<number>({ job: 'next' });
  fake.onmessage!({ data: { id: posted[0]!.id, result: 'stale' } } as MessageEvent);
  check(posted.length === 2 && !terminated && !cloned, 'ignore stale result without respawning worker');
  fake.onmessage!({ data: { id: posted[1]!.id, result: 42 } } as MessageEvent);
  check(await next === 42 && rpc.pending === 0, 'pump next valid worker request');
  const disposed = rpc.request({ job: 'dispose' }).then(() => false, () => true);
  rpc.dispose(); check(await disposed && terminated && rpc.pending === 0, 'worker dispose rejects and releases outstanding requests');
  for (const pixelRatio of [1, 1.25, 2]) {
  renderer.setPixelRatio(pixelRatio);
  for (const [declaredScheme, overrideScheme] of [
    ['xyz', undefined], ['tms', undefined], ['xyz', 'tms'], ['tms', 'xyz']
  ] as const) {
    const scheme = overrideScheme ?? declaredScheme;
    const urls: string[] = [];
    const style: MapStyle = { version: 8, sources: { fixture: { type: 'vector', scheme: declaredScheme,
      tiles: ['https://fixture/{z}/{x}/{y}/{-y}'] } }, layers: ['north', 'south'].map((half) => ({
        id: half, type: 'fill', source: 'fixture', 'source-layer': 'halves',
        filter: ['==', 'half', half], paint: { 'fill-color': half === 'north' ? '#ff0000' : '#00ff00' }
      })) };
    style.layers.push({ id: 'unsupported-pattern', type: 'fill', source: 'fixture',
      'source-layer': 'halves', paint: { 'fill-pattern': 'unavailable-sprite' } });
    const provider = new GpuVectorTileProvider({ id: scheme, style, renderer, tileSize: 128,
      source: overrideScheme ? { scheme: overrideScheme } : undefined,
      fetcher: async (url) => { urls.push(String(url)); return new Response(bytes.slice()); } });
    await provider.initialize();
    renderer.setRenderTarget(stateTarget);
    renderer.setViewport(1, 2, 7, 8);
    const texture = await provider.loadTexture({ level: 2, x: 1, y: 0 });
    check(urls[0] === `https://fixture/2/1/${scheme === 'xyz' ? 0 : 3}/3`, `${scheme} request row`);
    check(renderer.getRenderTarget() === stateTarget, 'render target restore');
    check(renderer.getViewport(new THREE.Vector4()).equals(new THREE.Vector4(1, 2, 7, 8)), 'viewport restore');
    check(renderer.getCurrentViewport(new THREE.Vector4()).equals(stateTarget.viewport), 'physical target viewport restore');
    material.uniforms.map.value = texture;
    for (const [crop, northExpected, southExpected] of [
      [new THREE.Vector4(1, 1, 0, 0), 0, 1],
      [new THREE.Vector4(.5, .5, 0, 0), 0, 0],
      [new THREE.Vector4(.5, .5, 0, .5), 1, 1]
    ] as const) {
      material.uniforms.crop.value = crop;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
      for (const [y, channel] of [[96, northExpected], [32, southExpected]]) {
        const offset = (y * 128 + 64) * 4;
        check(pixels[offset + channel] > 240 && pixels[offset + 1 - channel] < 10,
          `${scheme} surface/parent crop orientation at ${y}: ${pixels.slice(offset, offset + 4)}`);
      }
    }
    texture.dispose(); provider.dispose();
  }
  }
  // Four distinct tiles contain one continuous, asymmetric world-space band.
  // It crosses both X and Y seams; per-tile flips/crops cannot pass this test.
  renderer.setPixelRatio(2);
  const adjacent = new GpuVectorTileProvider({ id: 'adjacent', renderer, tileSize: 128,
    style: { version: 8, sources: { fixture: { type: 'vector', tiles: ['https://fixture/{z}/{x}/{y}'] } },
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#000000' } },
        { id: 'band', type: 'fill', source: 'fixture', 'source-layer': 'band', paint: { 'fill-color': '#ff0000' } }] },
    fetcher: async (url) => {
      const [, x, y] = String(url).match(/\/1\/(\d+)\/(\d+)$/)!;
      const pbf = new PbfWriter();
      pbf.writeMessage(3, (_, layer) => {
        layer.writeStringField(1, 'band'); layer.writeVarintField(5, 4096); layer.writeVarintField(15, 2);
        layer.writeMessage(2, (_, feature) => {
          feature.writeVarintField(3, 3);
          const commands: number[] = [];
          let previousX = 0, previousY = 0;
          for (const [index, point] of [[0, .21], [2, 1.21], [2, 1.29], [0, .29]].entries()) {
            const px = Math.round((point[0] - Number(x)) * 4096);
            const py = Math.round((point[1] - Number(y)) * 4096);
            if (index === 0) commands.push(9);
            else if (index === 1) commands.push(26);
            commands.push(zigzag(px - previousX), zigzag(py - previousY));
            previousX = px; previousY = py;
          }
          commands.push(15); feature.writePackedVarint(4, commands);
        }, null);
      }, null);
      return new Response(pbf.finish());
    } });
  await adjacent.initialize();
  const textures = [];
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    textures.push(await adjacent.loadTexture({ level: 1, x, y }));
  }
  const atlasMaterial = new THREE.ShaderMaterial({
    uniforms: Object.fromEntries(textures.map((texture, index) => [`tile${index}`, { value: texture }])),
    vertexShader: 'varying vec2 xyzUv;void main(){xyzUv=vec2(uv.x,1.0-uv.y);gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader: `uniform sampler2D tile0,tile1,tile2,tile3;varying vec2 xyzUv;void main(){
      vec2 p=xyzUv*2.0;vec2 q=vec2(fract(p.x),1.0-fract(p.y));
      gl_FragColor=p.y<1.0?(p.x<1.0?texture2D(tile0,q):texture2D(tile1,q)):
        (p.x<1.0?texture2D(tile2,q):texture2D(tile3,q));}`, depthTest: false, depthWrite: false
  });
  const atlasScene = new THREE.Scene();
  atlasScene.add(new THREE.Mesh(geometry, atlasMaterial));
  renderer.setRenderTarget(target); renderer.render(atlasScene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
  for (const [x, y] of [[.98, .74], [1.02, .76], [1.48, .99], [1.52, 1.01]]) {
    const offset = (Math.floor((1 - y / 2) * 128) * 128 + Math.floor(x / 2 * 128)) * 4;
    check(pixels[offset] > 230 && pixels[offset + 1] < 10, `adjacent seam ${x}/${y}: ${pixels.slice(offset, offset + 4)}`);
  }
  atlasMaterial.dispose(); textures.forEach((texture) => texture.dispose()); adjacent.dispose();
  // Network zoom stays at 2, while z19/20 styles are evaluated and redrawn.
  const overzoomUrls: string[] = [];
  const overzoom = new GpuVectorTileProvider({ id: 'overzoom', renderer, tileSize: 128, maxLevel: 2,
    style: { version: 8, sources: { fixture: { type: 'vector', tiles: ['https://fixture/{z}/{x}/{y}'] } },
      layers: [{ id: 'land', type: 'fill', source: 'fixture', 'source-layer': 'halves', minzoom: 19,
        paint: { 'fill-color': ['step', ['zoom'], '#0000ff', 20, '#00ff00'] } },
        { id: 'road', type: 'line', source: 'fixture', 'source-layer': 'halves',
          filter: ['==', '$type', 'LineString'],
          paint: { 'line-color': '#ff0000', 'line-width': 6 } }] },
    fetcher: async (url) => { overzoomUrls.push(String(url)); return new Response(bytes.slice()); } });
  await overzoom.initialize();
  overzoom.setViewLevel(20);
  check(overzoom.currentSourceLevel > 16, 'display zoom must not be capped at network zoom');
  for (const zoom of [19, 20]) {
    const texture = await overzoom.loadTexture({ level: zoom, x: 0, y: 0 });
    material.uniforms.map.value = texture;
    material.uniforms.crop.value = new THREE.Vector4(1, 1, 0, 0);
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
    const offset = (64 * 128 + 64) * 4;
    check(pixels[offset + (zoom === 19 ? 2 : 1)] > 240, `overzoom style evaluated at ${zoom}`);
    texture.dispose();
  }
  const roadTexture = await overzoom.loadTexture({ level: 4, x: 0, y: 2 });
  material.uniforms.map.value = roadTexture;
  renderer.setRenderTarget(target); renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
  let roadWidth = 0;
  for (let y = 0; y < 128; y++) if (pixels[(y * 128 + 64) * 4] > 240) roadWidth++;
  check(roadWidth === 6, `overzoom line width must stay 6 pixels, got ${roadWidth}`);
  roadTexture.dispose();
  const retainedMaterials = (overzoom as unknown as { surfaceMaterials: Map<string, THREE.ShaderMaterial> }).surfaceMaterials;
  check(retainedMaterials.size > 0 && retainedMaterials.size <= 256,
    'surface pass must retain bounded shader materials between tile draws');
  check(overzoomUrls.length === 1 && overzoomUrls[0] === 'https://fixture/2/0/0', 'parent PBF must be fetched/decoded once');
  const controller = new AbortController();
  const cancelled = overzoom.loadTexture({ level: 19, x: 1, y: 0 }, controller.signal);
  const observedCancellation = cancelled.then(() => false, () => true);
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  check(overzoom.drawStats.queued > 0, 'cached content must still enter the per-frame draw queue');
  controller.abort();
  check(await observedCancellation, 'queued offscreen draw must cancel');
  check(overzoom.drawStats.queued === 0, 'cancelled draw must not remain queued');
  const pendingDispose = overzoom.loadTexture({ level: 19, x: 2, y: 0 });
  const observedDispose = pendingDispose.then(() => false, () => true);
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  overzoom.dispose();
  check(retainedMaterials.size === 0, 'provider disposal must release pooled surface materials');
  check(await observedDispose, 'disposing provider must reject queued draw');

  // Compile/render the actual shared terrain shader, not only the tile pass.
  let dem = new THREE.DataTexture(new Float32Array(9), 3, 3, THREE.RedFormat, THREE.FloatType);
  dem.needsUpdate = true;
  const terrain = { revision: 1, enabled: true, exaggeration: 1, resolveTexture: () => ({
    key: 'fixture', texture: dem, scale: 1, offsetX: 0, offsetY: 0, sourceLevel: 2,
    width: 3, height: 3, parentKey: '', parentTexture: null, parentScale: 1, parentOffsetX: 0, parentOffsetY: 0
  }), sampleHeight: () => 0, sampleTileHeight: (): number => terrain.enabled ? dem.image.data[0] : 0 };
  const surface = new RasterTileLayer(Ellipsoid.WGS84,
    new UrlTemplateRasterProvider({ id: 'empty', urlTemplate: 'https://fixture/{z}/{x}/{y}', minLevel: 2, maxLevel: 2 }),
    { terrain });
  surface.setOpacity(1);
  // No imagery request is needed to compile the terrain material.
  const id = { level: 2, x: 2, y: 1 };
  const rectangle = new WebMercatorTilingScheme().rectangle(id);
  (surface as unknown as { syncRenderTiles: (tiles: unknown[]) => void }).syncRenderTiles([
    { id, rectangle, screenPixels: 128, viewCenterDistance: 0 }
  ]);
  surface.object3d.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      const uniforms = (object.material as THREE.ShaderMaterial).uniforms;
      uniforms.hasTerrain.value = true; uniforms.terrainTexture.value = dem;
    }
  });
  (surface as unknown as { syncTerrainEdges: (tiles: unknown[]) => void }).syncTerrainEdges([
    { id, rectangle, screenPixels: 128, viewCenterDistance: 0 }
  ]);
  surface.object3d.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      const mask = object.geometry.getAttribute('terrainEdgeMask');
      check(Array.from(mask.array).some((value) => value === 1), 'shared ECEF edge must reach the actual GPU geometry');
    }
  });
  const surfaceScene = new THREE.Scene(); surfaceScene.add(surface.object3d);
  renderer.setRenderTarget(target); renderer.render(surfaceScene, camera);
  // Same logical tile, new immutable DEM resource: both GPU interior and
  // canonical boundary must move together, including after disposal/reload.
  const oldDem = dem;
  dem = new THREE.DataTexture(new Float32Array(9).fill(8000), 3, 3, THREE.RedFormat, THREE.FloatType);
  dem.needsUpdate = true; terrain.revision++; oldDem.dispose();
  (surface as unknown as { syncMaterials: (tiles: unknown[]) => void }).syncMaterials([
    { id, rectangle, screenPixels: 128, viewCenterDistance: 0 }
  ]);
  surface.object3d.traverse(object => {
    if (object instanceof THREE.Mesh) {
      check((object.material as THREE.ShaderMaterial).uniforms.terrainTexture.value === dem,
        'same coordinate DEM reload must bind the new GPU texture, not a disposed flat surface');
      const high = object.geometry.getAttribute('terrainEdgeHigh'), low = object.geometry.getAttribute('terrainEdgeLow');
      const point = new THREE.Vector3(high.getX(0) + low.getX(0), high.getY(0) + low.getY(0), high.getZ(0) + low.getZ(0));
      const expected = Ellipsoid.WGS84.cartographicToCartesian({ longitude: rectangle.west,
        latitude: rectangle.north, height: 8000.1 });
      check(point.distanceTo(expected) < .01, 'new perimeter and GPU interior must both use the 8000m source');
    }
  });
  renderer.render(surfaceScene, camera);
  terrain.enabled = false;
  surface.object3d.traverse((object) => {
    if (object instanceof THREE.Mesh) (object.material as THREE.ShaderMaterial).uniforms.hasTerrain.value = false;
  });
  (surface as unknown as { syncTerrainEdges: (tiles: unknown[]) => void }).syncTerrainEdges([
    { id, rectangle, screenPixels: 128, viewCenterDistance: 0 }
  ]);
  surface.object3d.traverse((object) => {
    if (object instanceof THREE.Mesh) check(Array.from(object.geometry.getAttribute('terrainEdgeMask').array)
      .some((value) => value === 1), 'flat globe must keep shared ECEF edge active without DEM');
  });
  renderer.render(surfaceScene, camera);
  surface.dispose(); dem.dispose();
  const labelId = { level: 2, x: 2, y: 1 };
  const labelStyle: MapStyle = { version: 8, sources: { fixture: { type: 'vector', tiles: ['https://fixture/{z}/{x}/{y}'] } },
    layers: [{ id: 'labels', type: 'symbol', source: 'fixture', 'source-layer': 'labels',
      layout: { 'text-field': ['get', 'name'], 'text-size': 12 }, paint: { 'text-color': '#000000' } }] };
  const labelTerrain = { revision: 1, enabled: true, exaggeration: 1, heightKey: 'local-a',
    maximumHeight: () => 0, resolveTexture: () => undefined, sampleHeight: () => 0,
    heightVersionAt: () => labelTerrain.heightKey };
  const labels = new MvtVectorLayer(Ellipsoid.WGS84, { id: 'label-test', style: labelStyle, terrain: labelTerrain,
    symbolsOnly: true, symbols: true, levelOffset: 0, maxLabelsPerTile: 8, maxVisibleLabels: 1, maxAllocatedLabels: 8,
    decodedTileLoader: async () => new Map([['labels', [{ type: 1, extent: 4096, properties: { name: '注记测试' },
      geometry: [[{ x: 2048, y: 2048 }]] }]]]) });
  await labels.initialize();
  const labelRectangle = new WebMercatorTilingScheme().rectangle(labelId);
  const labelLongitude = 45, labelLatitude = Math.atan(Math.sinh(Math.PI * .25)) * 180 / Math.PI;
  const labelCamera = new THREE.PerspectiveCamera(50, 1, 1, 100000000);
  labelCamera.position.copy(Ellipsoid.WGS84.cartographicToCartesian({ longitude: labelLongitude, latitude: labelLatitude, height: 100000 }));
  labelCamera.lookAt(Ellipsoid.WGS84.cartographicToCartesian({ longitude: labelLongitude, latitude: labelLatitude }));
  labelCamera.updateMatrixWorld();
  const labelSelection = [{ id: labelId, rectangle: labelRectangle, screenPixels: 128, viewCenterDistance: 0 }];
  labels.update(labelSelection, 2, labelCamera, 128, 128);
  for (let wait = 0; wait < 100 && !labels.stats.ready; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  labels.update(labelSelection, 2, labelCamera, 128, 128);
  check(labels.stats.visibleLabels === 1, 'independent label pass must visibly place the point text');
  labels.update(labelSelection, 6, labelCamera, 128, 128);
  check(labels.stats.visibleLabels === 1, 'lower selected LOD labels must not disappear when camera zoom is higher');
  labels.object3d.traverse((object) => {
    if (object instanceof THREE.Sprite) object.position.copy(Ellipsoid.WGS84.cartographicToCartesian({
      longitude: labelLongitude, latitude: labelLatitude, height: 8000 }));
  });
  labelCamera.position.copy(Ellipsoid.WGS84.cartographicToCartesian({
    longitude: labelLongitude, latitude: labelLatitude - 2, height: 1000 }));
  labelCamera.lookAt(Ellipsoid.WGS84.cartographicToCartesian({
    longitude: labelLongitude, latitude: labelLatitude, height: 8000 }));
  labelCamera.updateMatrixWorld();
  labels.update(labelSelection, 6, labelCamera, 128, 128);
  check(labels.stats.visibleLabels === 1, 'visible elevated label beyond its tangent-plane horizon must survive');
  check(labels.stats.allocatedLabels <= 8, 'label allocation budget');
  let repeatedTileChecks = 0;
  const labelsInternal = labels as unknown as { hasTile: (id: typeof labelId) => boolean };
  const originalHasTile = labelsInternal.hasTile.bind(labels);
  labelsInternal.hasTile = (id) => { repeatedTileChecks++; return originalHasTile(id); };
  labels.update(labelSelection, 6, labelCamera, 128, 128);
  check(repeatedTileChecks === 0, 'stationary labels must reuse visibility mapping instead of scanning tiles');
  let heightUpdates = 0;
  const labelPositions = labels as unknown as { positionLabel: (...args: unknown[]) => void };
  const originalPositionLabel = labelPositions.positionLabel.bind(labels);
  labelPositions.positionLabel = (...args) => { heightUpdates++; originalPositionLabel(...args); };
  labelTerrain.revision++; labels.update(labelSelection, 6, labelCamera, 128, 128);
  check(heightUpdates === 0, 'unrelated DEM revision must not resample label anchor heights');
  labelTerrain.heightKey = 'local-b'; labelTerrain.revision++;
  labels.update(labelSelection, 6, labelCamera, 128, 128);
  check(heightUpdates === 1, 'changed actual DEM binding must reposition the affected label');
  let surfaceGeometry = false;
  labels.object3d.traverse((object) => { if (object instanceof THREE.Mesh) surfaceGeometry = true; });
  check(!surfaceGeometry, 'label pass must not duplicate surface geometry');
  const labelScene = new THREE.Scene(); labelScene.add(labels.object3d);
  renderer.setRenderTarget(target); renderer.render(labelScene, labelCamera);
  labels.dispose();
  // Queue pressure must not start a permanent recreate/decode cycle, nor
  // attach a stale async result to the scene after its record is removed.
  let finishPending!: (tile: Map<string, never[]>) => void;
  let firstLoad = true;
  const pressureLabels = new MvtVectorLayer(Ellipsoid.WGS84, { id: 'label-pressure', style: labelStyle,
    symbolsOnly: true, symbols: true, levelOffset: 0, maxCachedTiles: 16, maxConcurrentRequests: 1,
    decodedTileLoader: async () => {
      if (!firstLoad) return new Map();
      firstLoad = false;
      return new Promise<Map<string, never[]>>((resolve) => { finishPending = resolve; });
    } });
  await pressureLabels.initialize();
  const pressureSelection = Array.from({ length: 40 }, (_, index) => {
    const id = { level: 8, x: 100 + index, y: 100 };
    return { id, rectangle: new WebMercatorTilingScheme().rectangle(id), screenPixels: 128, viewCenterDistance: 0 };
  });
  pressureLabels.update(pressureSelection, 8, labelCamera, 128, 128);
  const pressureRecords = (pressureLabels as unknown as { records: Map<string, unknown> }).records;
  check(pressureRecords.size === 40, 'label cache pressure must retain all desired queued records');
  const staleKey = pressureRecords.keys().next().value!;
  pressureRecords.delete(staleKey);
  finishPending(new Map());
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  check(pressureLabels.object3d.children.length === 0, 'stale decoded result must not attach an untracked group');
  pressureLabels.dispose();
  // Real DEM worker image decode/endpoint normalization, not a mocked callback.
  const demCanvas = document.createElement('canvas'); demCanvas.width = 17; demCanvas.height = 13;
  const demContext = demCanvas.getContext('2d')!, image = demContext.createImageData(17, 13);
  for (let y = 0; y < 13; y++) for (let x = 0; x < 17; x++) {
    const value = 100000 + y * 10000 + x * 100, p = (y * 17 + x) * 4;
    image.data[p] = value >> 16; image.data[p + 1] = value >> 8 & 255; image.data[p + 2] = value & 255; image.data[p + 3] = 255;
  }
  demContext.putImageData(image, 0, 0);
  const demBlob = await new Promise<Blob>(resolve => demCanvas.toBlob(blob => resolve(blob!)));
  const terrainService = new TerrainDecodeService();
  for (const encoding of ['mapbox', 'terrarium'] as const) {
    const workerField = await terrainService.decode(demBlob, encoding);
    const reference = await convertTerrainPixels(image.data, 17, 13, encoding);
    check(terrainService.stats.worker, 'DEM conversion must actually use Worker');
    check(workerField.width === 257 && workerField.height === 257, 'DEM endpoint dimensions');
    check(workerField.minimumHeight === reference.minimumHeight && workerField.maximumHeight === reference.maximumHeight, 'DEM conservative bounds');
    check(workerField.heights.every((value, index) => value === reference.heights[index]), 'DEM Worker/fallback exact XYZ pixel parity');
    const oldSource = Float32Array.from({ length: 17 * 13 }, (_, index) => {
      const p = index * 4, r = image.data[p]!, g = image.data[p + 1]!, b = image.data[p + 2]!;
      return encoding === 'terrarium' ? r * 256 + g + b / 256 - 32768 : -10000 + (r * 65536 + g * 256 + b) * .1;
    });
    check(workerField.heights.every((value, index) => {
      const sx = index % 257 / 256 * 16, sy = Math.floor(index / 257) / 256 * 12;
      const x = Math.floor(sx), y = Math.floor(sy), nextX = Math.min(x + 1, 16), nextY = Math.min(y + 1, 12);
      return value === Math.fround(THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(oldSource[y * 17 + x]!, oldSource[y * 17 + nextX]!, sx - x),
        THREE.MathUtils.lerp(oldSource[nextY * 17 + x]!, oldSource[nextY * 17 + nextX]!, sx - x), sy - y));
    }), 'DEM Worker must preserve legacy interpolation operation order and Float32 rounding');
  }
  terrainService.dispose();

  const chunkStyle: MapStyle = { version: 8, sources: { fixture: { type: 'vector', tiles: ['https://fixture/{z}/{x}/{y}'] } },
    layers: [{ id: 'many', type: 'fill', source: 'fixture', 'source-layer': 'many', paint: { 'fill-color': '#ff0000', 'fill-opacity': .5 } }] };
  const many: DecodedVectorTile = new Map([['many', Array.from({ length: 2000 }, (_, index) => ({
    id: index, type: 3 as const, properties: {}, extent: 4096,
    geometry: [[{ x: 0, y: 0 }, { x: 4096, y: 0 }, { x: 4096, y: 4096 }, { x: 0, y: 4096 }, { x: 0, y: 0 }]]
  }))]]) as unknown as DecodedVectorTile;
  const service = new VectorSurfaceService(); await service.initialize(chunkStyle);
  const plan = await service.build({ sourceId: 'fixture', sourceTile: { level: 2, x: 0, y: 0 }, zoom: 2,
    offset: { x: 0, y: 0 }, scale: 1, tileSize: 128, decoded: many }, 'many');
  check(service.stats.worker, 'surface style/geometry must actually use Worker');
  check(plan.chunks.length > 1 && plan.chunks.every(chunk => chunk.bytes <= 96 * 1024 && chunk.indices.length % 3 === 0),
    'huge single bucket must split into bounded complete primitives');
  const nativeService = new VectorNativeService(); await nativeService.initialize(chunkStyle, new Set(['fill']));
  const nativeBuckets = await nativeService.build(new Map([['many', many.get('many')!.slice(0, 1)]]), { level: 2, x: 0, y: 0 }, 'fixture');
  check(nativeBuckets[0]?.geometry?.positions instanceof Float32Array && nativeBuckets[0].geometry.indices.length > 0,
    'native/business geometry must return transferable shader-ready arrays');
  nativeService.dispose(); service.dispose();

  const sliced = new GpuVectorTileProvider({ id: 'sliced', renderer, tileSize: 128, style: chunkStyle,
    maxDrawChunksPerFrame: 1, fetcher: async () => new Response(bytes.slice()) });
  await sliced.initialize();
  const internal = sliced as unknown as { enqueueDraw: (plan: SurfacePlan, offset: THREE.Vector2, scale: number, signal?: AbortSignal) => Promise<THREE.Texture>;
    drawQueue: Array<{ target: THREE.WebGLRenderTarget | null }> };
  let published = false;
  const beforePartialTarget = renderer.getRenderTarget();
  const slicedTexture = internal.enqueueDraw(plan, new THREE.Vector2(), 1).then(texture => { published = true; return texture; });
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  check(!published && internal.drawQueue[0]?.target !== null, 'partial RenderTarget must not publish after first frame');
  check(renderer.getRenderTarget() === beforePartialTarget, 'partial surface pass must restore renderer target between frames');
  const completeTexture = await slicedTexture; completeTexture.dispose();
  const abortDraw = new AbortController();
  const partial = internal.enqueueDraw(plan, new THREE.Vector2(), 1, abortDraw.signal);
  const cancelledPartial = partial.then(() => false, () => true);
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  let partialDisposed = false;
  internal.drawQueue[0]!.target!.addEventListener('dispose', () => { partialDisposed = true; });
  abortDraw.abort();
  check(await cancelledPartial && partialDisposed && sliced.drawStats.queued === 0, 'cancel partial target and release queue/resources');
  sliced.dispose();
  check(failures.length === 0, failures.join('\n'));
  result.textContent = 'PASS: DPR/XYZ/TMS/seams/overzoom/cache/terrain + DEM/native/surface Workers, chunk publication/cancellation, point labels; no shader errors';
  result.setAttribute('data-status', 'passed');
} catch (error) {
  result.textContent = `FAIL: ${error instanceof Error ? error.stack : error}`;
  result.setAttribute('data-status', 'failed');
} finally {
  target.dispose(); stateTarget.dispose(); geometry.dispose(); material.dispose(); renderer.dispose();
}
