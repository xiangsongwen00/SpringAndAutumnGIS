import { DEFAULT_LEVEL_OFFSET } from '../tiles/RasterTileProvider';
import type { DataSourceDefinition, DataSourceKind } from './DataSourceRegistry';
import type { LayerDefinition, LayerKind, LayerRole } from './LayerTypes';

export type LayerCatalog = Readonly<{
  version: 1;
  defaultBaseLayerId: string;
  defaults: Readonly<{ levelOffset: number }>;
  sources: readonly DataSourceDefinition[];
  layers: readonly LayerDefinition[];
}>;

export type LayerCatalogIssue = Readonly<{ path: string; message: string }>;
export type LayerCatalogValidation = Readonly<{
  valid: boolean;
  issues: readonly LayerCatalogIssue[];
}>;

const SOURCE_KINDS: readonly DataSourceKind[] = [
  'xyz-raster', 'wmts-raster', 'rasterized-vector-style', 'mvt', 'geojson'
];
const LAYER_KINDS: readonly LayerKind[] = [
  'imagery', 'rasterized-vector', 'terrain', 'vector', 'feature', 'annotation'
];
const LAYER_ROLES: readonly LayerRole[] = ['base', 'overlay', 'annotation', 'terrain'];

/** Runtime validation complements the JSON schema for imported/user-authored projects. */
export function validateLayerCatalog(input: unknown): LayerCatalogValidation {
  const issues: LayerCatalogIssue[] = [];
  if (!isRecord(input)) return { valid: false, issues: [{ path: '$', message: 'Expected an object.' }] };
  if (input.version !== 1) issue(issues, '$.version', 'Only catalog version 1 is supported.');
  const defaultBaseLayerId = stringValue(input.defaultBaseLayerId, '$.defaultBaseLayerId', issues);
  const defaults = input.defaults;
  if (!isRecord(defaults)) issue(issues, '$.defaults', 'Expected an object.');
  else validateLevelOffset(defaults.levelOffset, '$.defaults.levelOffset', issues);

  const sourceIds = new Set<string>();
  const sources = Array.isArray(input.sources) ? input.sources : [];
  if (!Array.isArray(input.sources)) issue(issues, '$.sources', 'Expected an array.');
  sources.forEach((value, index) => {
    const path = `$.sources[${index}]`;
    if (!isRecord(value)) return issue(issues, path, 'Expected an object.');
    const id = stringValue(value.id, `${path}.id`, issues);
    stringValue(value.name, `${path}.name`, issues);
    if (id && sourceIds.has(id)) issue(issues, `${path}.id`, `Duplicate source id: ${id}`);
    if (id) sourceIds.add(id);
    if (!SOURCE_KINDS.includes(value.kind as DataSourceKind)) {
      issue(issues, `${path}.kind`, 'Unsupported source kind.');
    }
    if (value.kind === 'rasterized-vector-style' && !nonEmptyString(value.styleUrl)) {
      issue(issues, `${path}.styleUrl`, 'styleUrl is required for rasterized vector styles.');
    }
    if (['xyz-raster', 'mvt'].includes(String(value.kind)) && !nonEmptyString(value.urlTemplate)) {
      issue(issues, `${path}.urlTemplate`, 'urlTemplate is required for tiled sources.');
    }
    if (value.kind === 'wmts-raster' && !nonEmptyString(value.urlTemplate) && !nonEmptyString(value.capabilitiesUrl)) {
      issue(issues, path, 'WMTS requires urlTemplate or capabilitiesUrl.');
    }
    if (value.kind === 'wmts-raster' && nonEmptyString(value.capabilitiesUrl)) {
      if (!nonEmptyString(value.layer)) issue(issues, `${path}.layer`, 'layer is required with capabilitiesUrl.');
      if (!nonEmptyString(value.tileMatrixSet)) issue(issues, `${path}.tileMatrixSet`, 'tileMatrixSet is required with capabilitiesUrl.');
    }
    if (value.kind === 'geojson' && !nonEmptyString(value.url)) {
      issue(issues, `${path}.url`, 'url is required for GeoJSON.');
    }
    validateOptionalLevel(value.minLevel, `${path}.minLevel`, issues);
    validateOptionalLevel(value.maxLevel, `${path}.maxLevel`, issues);
    if (typeof value.minLevel === 'number' && typeof value.maxLevel === 'number' && value.minLevel > value.maxLevel) {
      issue(issues, path, 'minLevel cannot exceed maxLevel.');
    }
    if (value.levelOffset !== undefined) validateLevelOffset(value.levelOffset, `${path}.levelOffset`, issues);
    if (value.bounds !== undefined) {
      if (!Array.isArray(value.bounds) || value.bounds.length !== 4 ||
          !value.bounds.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
        issue(issues, `${path}.bounds`, 'Bounds must be [west, south, east, north].');
      } else if ((value.bounds[1] as number) >= (value.bounds[3] as number)) {
        issue(issues, `${path}.bounds`, 'Bounds south must be lower than north.');
      }
    }
  });

  const layerIds = new Set<string>();
  const layers = Array.isArray(input.layers) ? input.layers : [];
  if (!Array.isArray(input.layers)) issue(issues, '$.layers', 'Expected an array.');
  layers.forEach((value, index) => {
    const path = `$.layers[${index}]`;
    if (!isRecord(value)) return issue(issues, path, 'Expected an object.');
    const id = stringValue(value.id, `${path}.id`, issues);
    stringValue(value.name, `${path}.name`, issues);
    const sourceId = stringValue(value.sourceId, `${path}.sourceId`, issues);
    if (id && layerIds.has(id)) issue(issues, `${path}.id`, `Duplicate layer id: ${id}`);
    if (id) layerIds.add(id);
    if (sourceId && !sourceIds.has(sourceId)) issue(issues, `${path}.sourceId`, `Unknown source: ${sourceId}`);
    if (!LAYER_KINDS.includes(value.kind as LayerKind)) issue(issues, `${path}.kind`, 'Unsupported layer kind.');
    if (!LAYER_ROLES.includes(value.role as LayerRole)) issue(issues, `${path}.role`, 'Unsupported layer role.');
    if (value.opacity !== undefined && (typeof value.opacity !== 'number' || value.opacity < 0 || value.opacity > 1)) {
      issue(issues, `${path}.opacity`, 'Opacity must be between 0 and 1.');
    }
    if (value.levelOffset !== undefined) validateLevelOffset(value.levelOffset, `${path}.levelOffset`, issues);
  });
  if (defaultBaseLayerId && !layerIds.has(defaultBaseLayerId)) {
    issue(issues, '$.defaultBaseLayerId', `Unknown layer: ${defaultBaseLayerId}`);
  }
  layers.forEach((value, index) => {
    if (!isRecord(value)) return;
    const path = `$.layers[${index}]`;
    if (nonEmptyString(value.parentLayerId) && !layerIds.has(value.parentLayerId)) {
      issue(issues, `${path}.parentLayerId`, `Unknown layer: ${value.parentLayerId}`);
    }
    if (Array.isArray(value.annotationLayerIds)) {
      value.annotationLayerIds.forEach((id, annotationIndex) => {
        if (!nonEmptyString(id) || !layerIds.has(id)) {
          issue(issues, `${path}.annotationLayerIds[${annotationIndex}]`, `Unknown layer: ${String(id)}`);
        }
      });
    }
  });
  return { valid: issues.length === 0, issues };
}

export function parseLayerCatalog(input: unknown): LayerCatalog {
  const validation = validateLayerCatalog(input);
  if (!validation.valid) {
    throw new Error(`Invalid layer catalog:\n${validation.issues.map((entry) => `${entry.path}: ${entry.message}`).join('\n')}`);
  }
  return cloneCatalog(input as LayerCatalog);
}

export function serializeLayerCatalog(catalog: LayerCatalog, space = 2): string {
  const parsed = parseLayerCatalog(catalog);
  return JSON.stringify(parsed, null, space);
}

export function createLayerCatalog(options: Omit<LayerCatalog, 'version' | 'defaults'> & {
  levelOffset?: number;
}): LayerCatalog {
  return parseLayerCatalog({
    version: 1,
    defaultBaseLayerId: options.defaultBaseLayerId,
    defaults: { levelOffset: options.levelOffset ?? DEFAULT_LEVEL_OFFSET },
    sources: options.sources,
    layers: options.layers
  });
}

function cloneCatalog(catalog: LayerCatalog): LayerCatalog {
  return JSON.parse(JSON.stringify(catalog)) as LayerCatalog;
}

function validateLevelOffset(value: unknown, path: string, issues: LayerCatalogIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -8 || value > 2) {
    issue(issues, path, 'Level offset must be a finite number between -8 and 2.');
  }
}

function validateOptionalLevel(value: unknown, path: string, issues: LayerCatalogIssue[]): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
    issue(issues, path, 'Level must be a non-negative integer.');
  }
}

function stringValue(value: unknown, path: string, issues: LayerCatalogIssue[]): string {
  if (!nonEmptyString(value)) {
    issue(issues, path, 'Expected a non-empty string.');
    return '';
  }
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(issues: LayerCatalogIssue[], path: string, message: string): void {
  issues.push({ path, message });
}
