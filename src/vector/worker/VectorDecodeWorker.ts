import { MvtDecoder } from '../decoder/MvtDecoder';

const decoder = new MvtDecoder();
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ id: number; bytes: ArrayBuffer; layers?: string[] }>) => void;
  postMessage: (message: unknown) => void;
};
scope.onmessage = ({ data }) => {
  try {
    const tile = decoder.decode(data.bytes, data.layers ? new Set(data.layers) : undefined);
    scope.postMessage({ id: data.id, tile });
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
