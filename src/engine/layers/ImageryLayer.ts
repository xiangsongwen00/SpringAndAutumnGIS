import type { TileProvider } from '../tiles/TileProvider';

export type LayerVisibility = {
  visible: boolean;
  opacity: number;
};

export class ImageryLayer {
  readonly id: string;
  readonly provider: TileProvider;

  private _visible: boolean;
  private _opacity: number;

  constructor(options: { id?: string; provider: TileProvider; visible?: boolean; opacity?: number }) {
    this.id = options.id ?? options.provider.id;
    this.provider = options.provider;
    this._visible = options.visible ?? true;
    this._opacity = clampOpacity(options.opacity ?? 1);
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(value: boolean) {
    this._visible = value;
  }

  get opacity(): number {
    return this._opacity;
  }

  set opacity(value: number) {
    this._opacity = clampOpacity(value);
  }

  get visibility(): LayerVisibility {
    return {
      visible: this._visible,
      opacity: this._opacity
    };
  }
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}
