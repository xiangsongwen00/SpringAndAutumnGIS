import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  DataSourceRegistry,
  Ellipsoid,
  GlobeLodSelector,
  RasterTileLayer,
  RequestScheduler,
  TileStateMachine,
  WmtsRasterProvider,
  loadWmtsCapabilities,
  parseWmtsCapabilities,
  tileContentId
} from '../dist/spring-and-autumn-gis.es.js';

const lodCamera = new THREE.PerspectiveCamera(50, 1, 1, 100_000_000);
lodCamera.position.set(0, 0, 12_000_000);
lodCamera.lookAt(0, 0, 0);
lodCamera.updateProjectionMatrix();
const lodResult = new GlobeLodSelector({ minLevel: 2, maxLevel: 6, maxTiles: 64 })
  .select(lodCamera, 800);
assert.ok(lodResult.tiles.length > 0);
assert.ok(lodResult.tiles.every((tile) => Number.isFinite(tile.viewCenterDistance)));
assert.ok(Math.min(...lodResult.tiles.map((tile) => tile.viewCenterDistance)) < 0.5);

const baseSurface = new RasterTileLayer(Ellipsoid.WGS84, {
  id: 'surface-base', minLevel: 0, maxLevel: 6,
  url: () => 'data:image/png;base64,',
  loadTexture: async () => new THREE.Texture()
}, { segments: 16, surfaceOffset: 0.1 });
const overlaySurface = new RasterTileLayer(Ellipsoid.WGS84, {
  id: 'surface-overlay', minLevel: 0, maxLevel: 6,
  url: () => 'data:image/png;base64,',
  loadTexture: async () => new THREE.Texture()
}, { segments: 16, surfaceOffset: 0.1, overlay: true });
const surfaceSelection = lodResult.tiles.slice(0, 1);
baseSurface.update(surfaceSelection, lodCamera.position);
overlaySurface.update(surfaceSelection, lodCamera.position);
await Promise.resolve();
await Promise.resolve();
baseSurface.update(surfaceSelection, lodCamera.position);
overlaySurface.update(surfaceSelection, lodCamera.position);
const baseMaterial = baseSurface.object3d.children[0].material;
const overlayMaterial = overlaySurface.object3d.children[0].material;
assert.equal(baseMaterial.uniforms.sag_heightOffset.value, 0.1);
assert.equal(overlayMaterial.uniforms.sag_heightOffset.value, 0.1);
assert.equal(overlayMaterial.depthFunc, THREE.LessEqualDepth);
assert.equal(overlayMaterial.depthWrite, false);
assert.equal(overlayMaterial.premultipliedAlpha, true);
assert.equal(overlayMaterial.uniforms.tileTexture.value.generateMipmaps, false);
assert.equal(overlayMaterial.uniforms.tileTexture.value.premultiplyAlpha, true);
baseSurface.dispose();
overlaySurface.dispose();

const wmtsFixture = `<?xml version="1.0"?>
<Capabilities version="1.0.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink">
  <ows:OperationsMetadata><ows:Operation name="GetTile"><ows:DCP><ows:HTTP><ows:Get xlink:href="https://tiles.example/wmts?"/></ows:HTTP></ows:DCP></ows:Operation></ows:OperationsMetadata>
  <Contents>
    <Layer><ows:Title>Demo</ows:Title><ows:Identifier>demo:world</ows:Identifier>
      <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style><Format>image/png</Format>
      <TileMatrixSetLink><TileMatrixSet>EPSG:3857</TileMatrixSet>
        <TileMatrixSetLimits>
          <TileMatrixLimits><TileMatrix>EPSG:3857:0</TileMatrix><MinTileRow>0</MinTileRow><MaxTileRow>0</MaxTileRow><MinTileCol>0</MinTileCol><MaxTileCol>0</MaxTileCol></TileMatrixLimits>
          <TileMatrixLimits><TileMatrix>EPSG:3857:1</TileMatrix><MinTileRow>0</MinTileRow><MaxTileRow>0</MaxTileRow><MinTileCol>1</MinTileCol><MaxTileCol>1</MaxTileCol></TileMatrixLimits>
        </TileMatrixSetLimits>
      </TileMatrixSetLink>
      <ResourceURL format="image/png" resourceType="tile" template="https://tiles.example/{style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png"/>
    </Layer>
    <TileMatrixSet><ows:Identifier>EPSG:3857</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
      <TileMatrix><ows:Identifier>EPSG:3857:0</ows:Identifier><ScaleDenominator>559082264.029</ScaleDenominator><TopLeftCorner>-20037508.3428 20037508.3428</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>1</MatrixWidth><MatrixHeight>1</MatrixHeight></TileMatrix>
      <TileMatrix><ows:Identifier>EPSG:3857:1</ows:Identifier><ScaleDenominator>279541132.015</ScaleDenominator><TopLeftCorner>-20037508.3428 20037508.3428</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>2</MatrixWidth><MatrixHeight>2</MatrixHeight></TileMatrix>
    </TileMatrixSet>
  </Contents>
</Capabilities>`;

const wmts = parseWmtsCapabilities(wmtsFixture);
assert.equal(wmts.layers[0].identifier, 'demo:world');
assert.equal(wmts.tileMatrixSets[0].matrices.length, 2);
assert.equal(wmts.layers[0].tileMatrixSetLinks[0].limits.length, 2);
assert.equal(wmts.getTileKvpUrl, 'https://tiles.example/wmts?');
const wmtsProvider = new WmtsRasterProvider({
  capabilities: wmts,
  layer: 'demo:world',
  tileMatrixSet: 'EPSG:3857',
  levelOffset: 0
});
assert.equal(
  decodeURIComponent(wmtsProvider.url({ level: 1, x: 1, y: 0 })),
  'https://tiles.example/default/EPSG:3857/EPSG:3857:1/0/1.png'
);
assert.equal(wmtsProvider.hasTile({ level: 1, x: 1, y: 0 }), true);
assert.equal(wmtsProvider.hasTile({ level: 1, x: 0, y: 0 }), false);
assert.equal(wmtsProvider.hasTile({ level: 1, x: 1, y: 1 }), false);
const loadedWmts = await loadWmtsCapabilities('https://tiles.example/capabilities.xml', async () =>
  new Response(wmtsFixture, { status: 200, headers: { 'content-type': 'application/xml' } })
);
assert.equal(loadedWmts.layers.length, 1);
const wmtsRegistry = new DataSourceRegistry([{
  id: 'capabilities-wmts',
  name: 'Capabilities WMTS',
  kind: 'wmts-raster',
  capabilitiesUrl: '/test/geoserver/capabilities.xml',
  endpointBaseUrl: '/test/geoserver',
  layer: 'demo:world',
  tileMatrixSet: 'EPSG:3857',
  format: 'image/png'
}], {
  fetcher: async () => new Response(wmtsFixture, { status: 200 })
});
const proxiedProvider = await wmtsRegistry.createRasterProviderAsync('capabilities-wmts', {
  levelOffset: 0
});
assert.equal(
  proxiedProvider.url({ level: 1, x: 1, y: 0 }),
  '/test/geoserver/default/EPSG%3A3857/EPSG%3A3857%3A1/0/1.png'
);

const key = (level, x, y, sourceId = 'test') => ({
  sourceId,
  kind: 'imagery',
  level,
  x,
  y
});

const states = new TileStateMachine();
const leaf = key(3, 6, 2);
states.ensure(leaf);
states.transition(leaf, 'queued');
states.transition(leaf, 'loading');
states.transition(leaf, 'ready', { byteSize: 1024, lastAccessFrame: 7 });
assert.equal(states.get(leaf).state, 'ready');
assert.equal(states.get(leaf).byteSize, 1024);
assert.equal(states.resolveReadyAncestor(key(5, 24, 8)).id, tileContentId(leaf));
assert.throws(() => states.transition(leaf, 'loading'), /Invalid tile transition/);

const parent = key(2, 1, 1);
for (let dy = 0; dy < 2; dy += 1) {
  for (let dx = 0; dx < 2; dx += 1) {
    const child = key(3, parent.x * 2 + dx, parent.y * 2 + dy);
    states.transition(child, 'queued');
    states.transition(child, 'loading');
    if (dx !== 1 || dy !== 1) states.transition(child, 'ready');
  }
}
assert.equal(states.canReplaceWithChildren(parent), false);
const lastChild = key(3, 3, 3);
states.transition(lastChild, 'ready');
assert.equal(states.canReplaceWithChildren(parent), true);

const scheduler = new RequestScheduler({
  maxConcurrent: 1,
  maxConcurrentPerOrigin: 1,
  maxCacheBytes: 16
});
let unblock;
const blocker = scheduler.schedule(
  key(1, 0, 0, 'blocker'),
  () => new Promise((resolve) => { unblock = resolve; }),
  { origin: 'local', byteSize: 4 }
);
const order = [];
const low = scheduler.schedule(
  key(1, 0, 0, 'low'),
  async () => { order.push('low'); return 'low'; },
  { origin: 'local', priority: 20, byteSize: 4 }
);
const high = scheduler.schedule(
  key(1, 0, 0, 'high'),
  async () => { order.push('high'); return 'high'; },
  { origin: 'local', priority: 1, byteSize: 4 }
);
const duplicateHigh = scheduler.schedule(
  key(1, 0, 0, 'high'),
  async () => { throw new Error('deduplication failed'); },
  { origin: 'local', priority: 0, byteSize: 4 }
);
assert.equal(scheduler.stats.queued, 2);
unblock('blocker');
assert.deepEqual(await Promise.all([blocker.promise, high.promise, duplicateHigh.promise, low.promise]), [
  'blocker', 'high', 'high', 'low'
]);
assert.deepEqual(order, ['high', 'low']);
blocker.release();
high.release();
duplicateHigh.release();
low.release();
assert.ok(scheduler.stats.cacheBytes <= 16);

let releaseRunning;
const cancellationScheduler = new RequestScheduler({ maxConcurrent: 1 });
const running = cancellationScheduler.schedule(
  key(1, 0, 0, 'running'),
  () => new Promise((resolve) => { releaseRunning = resolve; })
);
const cancelled = cancellationScheduler.schedule(
  key(1, 0, 0, 'cancelled'),
  async () => 'unexpected'
);
cancelled.release();
await assert.rejects(cancelled.promise, { name: 'AbortError' });
assert.equal(cancellationScheduler.stateMachine.get(cancelled.key).state, 'cancelled');
releaseRunning('done');
assert.equal(await running.promise, 'done');
running.release();

console.log('Tile runtime checks passed.');
