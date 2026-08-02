/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_TERRAIN?: string;
  readonly VITE_GEOVIS_TERRAIN_URL?: string;
  readonly VITE_GEOVIS_TERRAIN_SCHEME?: 'xyz' | 'tms';
  readonly VITE_MAPTILER_KEY?: string;
  readonly VITE_TERRAIN_EXAGGERATION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
