import { WebMercatorTilingScheme } from '../tiling/WebMercatorTilingScheme';
import { tileKey, type TileId } from '../tiling/GeographicTilingScheme';
import type { SelectedTile } from './GlobeLodSelector';

/** Refine mesh footprints with READY terrain only; never changes imagery requests.
 * No overlapping parent and child draws. Separate cap bounds mesh amplification.
 */
export function refineSurfaceCover(imagery: readonly SelectedTile[], terrain: readonly SelectedTile[], maxTiles = 512): readonly SelectedTile[] {
  const splits = new Map<string, number>(), scheme = new WebMercatorTilingScheme();
  for (const [rank, tile] of terrain.entries()) for (let level = tile.id.level - 1; level >= 0; level--) {
    const shift = 2 ** (tile.id.level - level);
    const key = tileKey({ level, x: Math.floor(tile.id.x / shift), y: Math.floor(tile.id.y / shift) });
    if (!splits.has(key)) splits.set(key, rank);
  }
  const result = [...imagery];
  while (result.length + 3 <= maxTiles) {
    let index = -1, rank = Infinity;
    result.forEach((tile, i) => { const priority = splits.get(tileKey(tile.id));
      if (priority !== undefined && priority < rank) { index = i; rank = priority; } });
    if (index < 0) break;
    const tile = result[index]!;
    const children = scheme.children(tile.id).map(id => ({ ...tile, id, rectangle: scheme.rectangle(id), screenPixels: tile.screenPixels / 2 }));
    result.splice(index, 1, ...children);
  }
  return result.length === imagery.length ? imagery : result;
}

/** Source request footprint containing a subdivided surface footprint. */
export function containingTile(id: TileId, tiles: ReadonlyMap<string, SelectedTile>): SelectedTile | undefined {
  for (let level = id.level; level >= 0; level--) {
    const scale = 2 ** (id.level - level);
    const tile = tiles.get(tileKey({ level, x: Math.floor(id.x / scale), y: Math.floor(id.y / scale) }));
    if (tile) return tile;
  }
  return undefined;
}
