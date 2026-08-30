/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Beta Launch Hardening (Vercel + Render) — absolute Render API origin
   * in production, e.g. "https://api.yourdomain.com/api/v1". Set on
   * Vercel only; unset in local dev and in the Docker/nginx same-origin
   * deployment path, both of which rely on the relative "/api/v1"
   * fallback in src/api/client.ts.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
