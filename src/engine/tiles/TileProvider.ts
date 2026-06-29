export type TileYType = 'xyz' | 'tms';

export type TileCoord = {
  x: number;
  y: number;
  z: number;
};

export type TileProvider = {
  readonly id: string;
  readonly minZoom: number;
  readonly maxZoom: number;
  getTileUrl(tile: TileCoord): string;
};

export type UrlTileProviderOptions = {
  id?: string;
  urlTemplate: string;
  minZoom?: number;
  maxZoom?: number;
  yType?: TileYType;
  subdomains?: readonly string[] | string;
};

const DEFAULT_SUBDOMAINS = ['a', 'b', 'c'];

export class UrlTileProvider implements TileProvider {
  readonly id: string;
  readonly minZoom: number;
  readonly maxZoom: number;

  private readonly _urlTemplate: string;
  private readonly _yType: TileYType;
  private readonly _subdomains: readonly string[];

  constructor(options: UrlTileProviderOptions) {
    if (!options.urlTemplate || options.urlTemplate.trim().length === 0) {
      throw new Error('UrlTileProvider requires a urlTemplate.');
    }

    this.id = options.id ?? options.urlTemplate;
    this._urlTemplate = options.urlTemplate;
    this.minZoom = clampInt(options.minZoom ?? 0, 0, 30);
    this.maxZoom = clampInt(options.maxZoom ?? 22, this.minZoom, 30);
    this._yType = options.yType ?? 'xyz';
    this._subdomains = normalizeSubdomains(options.subdomains);
  }

  getTileUrl(tile: TileCoord): string {
    const z = clampInt(tile.z, this.minZoom, this.maxZoom);
    const n = 2 ** z;
    const x = wrapInt(tile.x, n);
    const rawY = clampInt(tile.y, 0, n - 1);
    const y = this._yType === 'tms' ? n - 1 - rawY : rawY;
    const s = this.pickSubdomain({ x, y: rawY, z });

    return this._urlTemplate
      .split('{z}')
      .join(String(z))
      .split('{x}')
      .join(String(x))
      .split('{y}')
      .join(String(y))
      .split('{s}')
      .join(s);
  }

  private pickSubdomain(tile: TileCoord): string {
    if (this._subdomains.length === 0) return '';
    const index = Math.abs(tile.x + tile.y + tile.z) % this._subdomains.length;
    return this._subdomains[index] ?? '';
  }
}

export function tileKey(tile: TileCoord): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function normalizeSubdomains(input: readonly string[] | string | undefined): readonly string[] {
  if (Array.isArray(input)) {
    const out = input.map((item) => String(item).trim()).filter((item) => item.length > 0);
    return out.length > 0 ? out : [];
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) return [];

    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (Number.isInteger(start) && Number.isInteger(end) && end >= start) {
        const out: string[] = [];
        for (let i = start; i <= end; i += 1) out.push(String(i));
        return out;
      }
    }

    const split = trimmed
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (split.length > 1) return split;
    return trimmed.length > 1 ? trimmed.split('') : [trimmed];
  }

  return DEFAULT_SUBDOMAINS;
}

function wrapInt(value: number, range: number): number {
  return ((value % range) + range) % range;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
