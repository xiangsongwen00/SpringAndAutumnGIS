import type { DataSourceDefinition } from './DataSourceRegistry';
import type { LayerDefinition } from './LayerTypes';
export type LayerCatalog = Readonly<{
    version: 1;
    defaultBaseLayerId: string;
    defaults: Readonly<{
        levelOffset: number;
    }>;
    sources: readonly DataSourceDefinition[];
    layers: readonly LayerDefinition[];
}>;
export type LayerCatalogIssue = Readonly<{
    path: string;
    message: string;
}>;
export type LayerCatalogValidation = Readonly<{
    valid: boolean;
    issues: readonly LayerCatalogIssue[];
}>;
/** Runtime validation complements the JSON schema for imported/user-authored projects. */
export declare function validateLayerCatalog(input: unknown): LayerCatalogValidation;
export declare function parseLayerCatalog(input: unknown): LayerCatalog;
export declare function serializeLayerCatalog(catalog: LayerCatalog, space?: number): string;
export declare function createLayerCatalog(options: Omit<LayerCatalog, 'version' | 'defaults'> & {
    levelOffset?: number;
}): LayerCatalog;
//# sourceMappingURL=LayerCatalog.d.ts.map