/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Release channel baked in at build time. `preview` disables the updater. */
  readonly VITE_TERAX_CHANNEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
