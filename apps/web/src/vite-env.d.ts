/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" installs the in-browser mock hub (src/dev/mock.ts). */
  readonly VITE_MOCK?: string;
}
