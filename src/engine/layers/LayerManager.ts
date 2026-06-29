import { ImageryLayer } from './ImageryLayer';

export class LayerManager {
  private readonly _imageryLayers: ImageryLayer[] = [];

  get imageryLayers(): readonly ImageryLayer[] {
    return [...this._imageryLayers];
  }

  addImageryLayer(layer: ImageryLayer): ImageryLayer {
    if (this._imageryLayers.some((item) => item.id === layer.id)) {
      throw new Error(`Imagery layer already exists: ${layer.id}`);
    }
    this._imageryLayers.push(layer);
    return layer;
  }

  removeImageryLayer(id: string): ImageryLayer | null {
    const index = this._imageryLayers.findIndex((layer) => layer.id === id);
    if (index < 0) return null;
    const [removed] = this._imageryLayers.splice(index, 1);
    return removed ?? null;
  }

  getImageryLayer(id: string): ImageryLayer | null {
    return this._imageryLayers.find((layer) => layer.id === id) ?? null;
  }

  clear(): void {
    this._imageryLayers.length = 0;
  }
}
