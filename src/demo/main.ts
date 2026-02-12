import { Viewer } from '../index';

const container = document.getElementById('app');
if (!container) {
  throw new Error('Missing #app container');
}

const viewer = new Viewer({
  container,
  planarValidation: {
    frontLonDeg: 0,
    initialCameraHeight: 12_000,
    lodGrid: false,
    mapTiles: {
      enabled: true,
      urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      minZoom: 0,
      maxZoom: 18,
      tileRadius: 3,
      maxDynamicTileRadius: 10,
      updateThrottleMs: 80,
      zoomThrottleMs: 140,
      immediateTileShift: 2,
      lodLevels: [
        { zoom: 18, maxTiles: 49, marginTiles: 1, updateThrottleMs: 100, zoomThrottleMs: 180 },
        { zoom: 16, maxTiles: 64, marginTiles: 1, updateThrottleMs: 90, zoomThrottleMs: 160 },
        { zoom: 14, maxTiles: 81, marginTiles: 1, updateThrottleMs: 80, zoomThrottleMs: 140 },
        { zoom: 12, maxTiles: 100, marginTiles: 1, updateThrottleMs: 70, zoomThrottleMs: 120 },
        { zoom: 10, maxTiles: 121, marginTiles: 2, updateThrottleMs: 60, zoomThrottleMs: 100 },
        { zoom: 8, maxTiles: 144, marginTiles: 2, updateThrottleMs: 50, zoomThrottleMs: 90 },
        { zoom: 6, maxTiles: 196, marginTiles: 3, updateThrottleMs: 40, zoomThrottleMs: 80 },
        { zoom: 4, maxTiles: 256, marginTiles: 3, updateThrottleMs: 32, zoomThrottleMs: 64 }
      ],
      debugOverlay: true,
      enableProgressiveBlend: false,
      fadeDurationMs: 180,
      maxParentSearchDepth: 6,
      opacity: 1,
      yType: 'xyz'
    }
  }
});

viewer.start();
