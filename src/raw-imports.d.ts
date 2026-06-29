declare module '*?raw' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}

declare module '*.png' {
  const value: string;
  export default value;
}

interface ImportMetaEnv {
  readonly VITE_SAG_TERRAIN_RGB_URL_TEMPLATE?: string;
  readonly VITE_SAG_IMAGERY_URL_TEMPLATE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
