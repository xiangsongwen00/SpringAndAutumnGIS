import { WEB_MERCATOR_MAX_LATITUDE } from '../coordinates/CoordinateTransform';
import {
  quadtreeChildren,
  type Rectangle,
  type TileId,
  type TilingScheme
} from './GeographicTilingScheme';

/** Standard slippy-map XYZ quadtree used by raster tile servers. */
export class WebMercatorTilingScheme implements TilingScheme {
  readonly id = 'web-mercator';
  readonly levelZeroTilesX = 1;
  readonly levelZeroTilesY = 1;

  rootTiles(): TileId[] {
    return [{ level: 0, x: 0, y: 0 }];
  }

  children(tile: TileId): TileId[] {
    return quadtreeChildren(tile);
  }

  rectangle(tile: TileId): Rectangle {
    const size = 2 ** tile.level;
    return {
      west: (tile.x / size) * 360 - 180,
      east: ((tile.x + 1) / size) * 360 - 180,
      north: tileYToLatitude(tile.y, size),
      south: tileYToLatitude(tile.y + 1, size)
    };
  }
}

function tileYToLatitude(y: number, size: number): number {
  const mercator = Math.PI * (1 - (2 * y) / size);
  const latitude = (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
  return Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude));
}

