import {
  Color, Formatted, derefLayers, featureFilter, latest, normalizePropertyExpression,
  type FilterSpecification, type LayerSpecification, type StylePropertySpecification
} from '@maplibre/maplibre-gl-style-spec';
import type { DecodedFeature, MapStyle, StyleLayer } from './VectorStyleTypes';

export type VectorStyleIssue = Readonly<{ layerId: string; property: string; message: string }>;
export type EvaluatedBucket = Readonly<{ layer: StyleLayer; features: readonly DecodedFeature[]; order: number }>;

/** Renderer-independent Style v8 compilation; both base and business sources use this. */
export class VectorStyleRuntime {
  readonly issues: VectorStyleIssue[] = [];
  readonly layers: readonly StyleLayer[];
  private readonly compiled = new Map<string, (zoom: number, feature?: DecodedFeature) => unknown>();
  private readonly filters = new Map<string, ReturnType<typeof featureFilter>>();

  constructor(style: MapStyle) {
    this.layers = derefLayers(style.layers as LayerSpecification[]) as StyleLayer[];
    const reference = latest as unknown as Record<string, Record<string, StylePropertySpecification>>;
    for (const layer of this.layers) {
      try {
        this.filters.set(layer.id, featureFilter(layer.filter as FilterSpecification, `${layer.id}.filter`));
      } catch (error) {
        this.issues.push({ layerId: layer.id, property: 'filter', message: String(error) });
      }
      for (const section of ['paint', 'layout'] as const) {
        for (const [property, value] of Object.entries(layer[section] ?? {})) {
          const spec = reference[`${section}_${layer.type}`]?.[property];
          if (!spec) continue;
          try {
            const expression = normalizePropertyExpression(value as never, `${layer.id}.${section}.${property}`, spec);
            this.compiled.set(`${layer.id}:${property}`, (zoom, feature) => {
              const result = expression.evaluate({ zoom }, feature);
              return result instanceof Color || result instanceof Formatted ? result.toString() : result;
            });
          } catch (error) {
            this.issues.push({ layerId: layer.id, property, message: String(error) });
          }
        }
      }
    }
  }

  evaluate(layer: StyleLayer, zoom: number, feature?: DecodedFeature): StyleLayer {
    const result: StyleLayer = { ...layer, paint: {}, layout: {} };
    for (const section of ['paint', 'layout'] as const) {
      for (const [property, value] of Object.entries(layer[section] ?? {})) {
        result[section]![property] = this.compiled.get(`${layer.id}:${property}`)?.(zoom, feature) ?? value;
      }
    }
    return result;
  }

  /** Group equally evaluated features into transferable bucket plans, preserving style order. */
  buckets(decoded: ReadonlyMap<string, readonly DecodedFeature[]>, sourceId: string, zoom: number,
    types?: ReadonlySet<string>): EvaluatedBucket[] {
    const result: EvaluatedBucket[] = [];
    this.layers.forEach((layer, order) => {
      if (types && !types.has(layer.type)) return;
      if (layer.source && layer.source !== sourceId ||
          layer.minzoom !== undefined && zoom < layer.minzoom ||
          layer.maxzoom !== undefined && zoom >= layer.maxzoom) return;
      if (layer.type === 'background') {
        const evaluated = this.evaluate(layer, zoom);
        if (evaluated.layout?.visibility !== 'none') result.push({ layer: evaluated, features: [], order });
        return;
      }
      const features = decoded.get(layer['source-layer'] ?? '') ?? [];
      const groups = new Map<string, { layer: StyleLayer; features: DecodedFeature[] }>();
      for (const feature of features) {
        const filter = this.filters.get(layer.id);
        // Invalid filters must never accidentally include the entire source layer.
        if (!filter || !filter.filter({ zoom }, feature)) continue;
        const evaluated = this.evaluate(layer, zoom, feature);
        if (evaluated.layout?.visibility === 'none') continue;
        const key = JSON.stringify([evaluated.paint, evaluated.layout]);
        let group = groups.get(key);
        if (!group) { group = { layer: evaluated, features: [] }; groups.set(key, group); }
        group.features.push(feature);
      }
      for (const group of groups.values()) result.push({ ...group, order });
    });
    return result;
  }
}
