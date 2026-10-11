// Build-time publishing config (electron-vite exposes MAIN_VITE_* variables to the main process).
interface ImportMetaEnv {
  readonly MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_ID?: string;
  readonly MAIN_VITE_SOLOCUT_YOUTUBE_CLIENT_SECRET?: string;
  readonly MAIN_VITE_SOLOCUT_TIKTOK_CLIENT_KEY?: string;
  readonly MAIN_VITE_SOLOCUT_TIKTOK_TOKEN_URL?: string;
  readonly MAIN_VITE_SOLOCUT_TIKTOK_DIRECT_POST?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
