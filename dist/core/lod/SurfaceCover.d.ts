import { type TileId } from '../tiling/GeographicTilingScheme';
import type { SelectedTile } from './GlobeLodSelector';
/** Refine mesh footprints with READY terrain only; never changes imagery requests.
 * No overlapping parent and child draws. Separate cap bounds mesh amplification.
 */
export declare function refineSurfaceCover(imagery: readonly SelectedTile[], terrain: readonly SelectedTile[], maxTiles?: number): readonly SelectedTile[];
/** Source request footprint containing a subdivided surface footprint. */
export declare function containingTile(id: TileId, tiles: ReadonlyMap<string, SelectedTile>): SelectedTile | undefined;
//# sourceMappingURL=SurfaceCover.d.ts.map