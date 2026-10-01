import * as THREE from 'three';
import { PbfWriter } from 'pbf';
import { GpuVectorTileProvider } from '../src/core/tiles/GpuVectorTileProvider';
import type { MapStyle } from '../src/vector/style/VectorStyleTypes';
import { RasterTileLayer } from '../src/render/RasterTileLayer';
import { UrlTemplateRasterProvider } from '../src/core/tiles/RasterTileProvider';
import { Ellipsoid } from '../src/core/geo/Ellipsoid';
import { WebMercatorTilingScheme } from '../src/core/tiling/WebMercatorTilingScheme';
import { MvtVectorLayer } from '../src/render/MvtVectorLayer';

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
  const dem = new THREE.DataTexture(new Float32Array(9), 3, 3, THREE.RedFormat, THREE.FloatType);
  dem.needsUpdate = true;
  const terrain = { revision: 1, enabled: true, exaggeration: 1, resolveTexture: () => ({
    key: 'fixture', texture: dem, scale: 1, offsetX: 0, offsetY: 0, sourceLevel: 2,
    width: 3, height: 3, parentKey: '', parentTexture: null, parentScale: 1, parentOffsetX: 0, parentOffsetY: 0
  }), sampleHeight: () => 0, sampleTileHeight: () => 0 };
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
  const labels = new MvtVectorLayer(Ellipsoid.WGS84, { id: 'label-test', style: labelStyle,
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
  let surfaceGeometry = false;
  labels.object3d.traverse((object) => { if (object instanceof THREE.Mesh) surfaceGeometry = true; });
  check(!surfaceGeometry, 'label pass must not duplicate surface geometry');
  const labelScene = new THREE.Scene(); labelScene.add(labels.object3d);
  renderer.setRenderTarget(target); renderer.render(labelScene, labelCamera);
  labels.dispose();
  check(failures.length === 0, failures.join('\n'));
  result.textContent = 'PASS: DPR/XYZ/TMS/seams/overzoom/cache/terrain + bounded independent point labels, no shader errors';
  result.setAttribute('data-status', 'passed');
} catch (error) {
  result.textContent = `FAIL: ${error instanceof Error ? error.stack : error}`;
  result.setAttribute('data-status', 'failed');
} finally {
  target.dispose(); stateTarget.dispose(); geometry.dispose(); material.dispose(); renderer.dispose();
}
