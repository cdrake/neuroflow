/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Registry URLs (neuroflow-registry.json or its folder) to load at start, comma separated. */
  readonly VITE_NEUROFLOW_REGISTRIES?: string
}
