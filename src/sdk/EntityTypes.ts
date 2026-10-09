/** WGS84 degrees and absolute ellipsoid height in metres (not terrain clamping). */
export type EntityPosition = readonly [longitude: number, latitude: number, height?: number];
export type PointIcon = { url: string; width?: number; height?: number;
  /** Direction of the unrotated asset: up=0, right=90, down=180, left=270. */
  sourceHeading?: number };
export type LineTexture = { url: string; length?: number;
  /** CSS pixels/second, positive follows positions order. */
  speed?: number; sourceDirection?: 'left' | 'right' };
export type PolygonTexture = { url: string; repeat?: readonly [number, number]; offset?: readonly [number, number];
  rotation?: number; /** Pattern translation in normalized UV units/second. */ speed?: readonly [number, number] };
export type PointSymbol = { color?: string; size?: number; shape?: 'circle' | 'square' | 'diamond'; outlineColor?: string; outlineWidth?: number; opacity?: number;
  icon?: PointIcon | null; heading?: number; alignment?: 'map' | 'screen' };
export type LineSymbol = { color?: string; width?: number; opacity?: number; dash?: readonly [onPixels: number, offPixels: number]; texture?: LineTexture | null };
export type PolygonSymbol = { color?: string; opacity?: number; fill?: boolean; outlineColor?: string; outlineWidth?: number; texture?: PolygonTexture | null };
export type LabelSymbol = { text: string; fontSize?: number; color?: string; haloColor?: string; haloWidth?: number;
  offset?: readonly [xPixels: number, yPixels: number]; backgroundColor?: string; padding?: number; opacity?: number };
type Common = { id: string; name?: string; visible?: boolean; properties?: Record<string, unknown>;
  /** Draw order below engine base annotations; 0..9000, default 500. */
  order?: number; label?: LabelSymbol };
export type EntityDefinition = Common & (
  | { type: 'point'; position: EntityPosition; symbol?: PointSymbol }
  | { type: 'polyline'; positions: readonly EntityPosition[]; symbol?: LineSymbol }
  | { type: 'polygon'; positions: readonly EntityPosition[]; holes?: readonly (readonly EntityPosition[])[]; symbol?: PolygonSymbol }
  | { type: 'label'; position: EntityPosition; label: LabelSymbol }
);
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type EntitySnapshot = DeepReadonly<EntityDefinition>;
/** Type/id stay stable; symbol and label fields merge, geometry arrays replace. null removes an attached label. */
export type EntityPatch = { name?: string; visible?: boolean; order?: number; properties?: Record<string, unknown>;
  position?: EntityPosition; positions?: readonly EntityPosition[]; holes?: readonly (readonly EntityPosition[])[];
  symbol?: PointSymbol | LineSymbol | PolygonSymbol; label?: Partial<LabelSymbol> | null };
export type EntityMove = { longitude?: number; latitude?: number; height?: number };
export type EntityQuery = { type?: EntityDefinition['type']; visible?: boolean; name?: string;
  /** Anchor-in-bounds query; west > east represents crossing the antimeridian. */
  bounds?: { west: number; south: number; east: number; north: number };
  properties?: Record<string, unknown> };
export type EntityChange = Readonly<{ type: 'add' | 'update' | 'remove' | 'clear' | 'visibility'; id?: string; fields?: readonly string[] }>;
export type EntityPickOptions = { tolerance?: number };
export type ScreenPosition = { x: number; y: number };
export type EntityResourceState = Readonly<{ state: 'none' | 'pending' | 'loading' | 'ready' | 'error'; images: number }>;
