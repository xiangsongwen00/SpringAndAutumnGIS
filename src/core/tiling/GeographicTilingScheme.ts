export type TileId = Readonly<{ level: number; x: number; y: number }>;

export type Rectangle = Readonly<{
  west: number;
  south: number;
  east: number;
  north: number;
}>;

export interface TilingScheme {
  readonly id: string;
  readonly levelZeroTilesX: number;
  readonly levelZeroTilesY: number;
  rootTiles(): TileId[];
  children(tile: TileId): TileId[];
  rectangle(tile: TileId): Rectangle;
}

/** EPSG:4326-like quadtree: level zero contains two 180-by-180-degree roots. */
export class GeographicTilingScheme implements TilingScheme {
  readonly id = 'geographic';
  readonly levelZeroTilesX = 2;
  readonly levelZeroTilesY = 1;

  rootTiles(): TileId[] {
    return [
      { level: 0, x: 0, y: 0 },
      { level: 0, x: 1, y: 0 }
    ];
  }

  children(tile: TileId): TileId[] {
    return quadtreeChildren(tile);
  }

  rectangle(tile: TileId): Rectangle {
    const columns = this.levelZeroTilesX * 2 ** tile.level;
    const rows = this.levelZeroTilesY * 2 ** tile.level;
    const longitudeSpan = 360 / columns;
    const latitudeSpan = 180 / rows;
    return {
      west: -180 + tile.x * longitudeSpan,
      east: -180 + (tile.x + 1) * longitudeSpan,
      north: 90 - tile.y * latitudeSpan,
      south: 90 - (tile.y + 1) * latitudeSpan
    };
  }
}

export function quadtreeChildren(tile: TileId): TileId[] {
  const level = tile.level + 1;
  const x = tile.x * 2;
  const y = tile.y * 2;
  return [
    { level, x, y },
    { level, x: x + 1, y },
    { level, x, y: y + 1 },
    { level, x: x + 1, y: y + 1 }
  ];
}

export function tileKey(tile: TileId): string {
  return `${tile.level}/${tile.x}/${tile.y}`;
}

