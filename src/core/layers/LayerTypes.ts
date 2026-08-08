export type LayerKind =
  | 'imagery'
  | 'rasterized-vector'
  | 'terrain'
  | 'vector'
  | 'feature'
  | 'annotation';

export type LayerRole = 'base' | 'overlay' | 'annotation' | 'terrain';

export type LayerState = Readonly<{
  id: string;
  name: string;
  kind: LayerKind;
  role: LayerRole;
  sourceId: string;
  visible: boolean;
  opacity: number;
  order: number;
  levelOffset: number;
  minCameraLevel?: number;
  maxCameraLevel?: number;
  blendMode?: 'normal' | 'multiply' | 'screen';
  exclusiveGroup?: string;
  parentLayerId?: string;
  annotationLayerIds?: readonly string[];
  attribution?: string;
}>;

export type LayerDefinition = Omit<LayerState, 'visible' | 'opacity' | 'order' | 'levelOffset'> &
  Partial<Pick<LayerState, 'visible' | 'opacity' | 'order' | 'levelOffset'>>;

export type LayerStatePatch = Partial<Omit<LayerState, 'id' | 'sourceId' | 'kind'>>;

export type LayerCollectionChange = Readonly<{
  type: 'add' | 'remove' | 'update' | 'reorder' | 'reset';
  layerId?: string;
  revision: number;
}>;

export type LayerCollectionListener = (change: LayerCollectionChange) => void;
