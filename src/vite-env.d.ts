/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_VCONSOLE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
