import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";
import { stripDevMessages } from "./vite/dev-messages.ts";
import { pwaOptions } from "./vite/pwa.ts";

// Vite runs under Node; the web tsconfig has no Node types, so declare just what is read here.
declare const process: { env: Record<string, string | undefined> };

// Same default as apps/server/entry/bun.ts; PORT comes from .env.local via `bun run dev`.
const apiPort = process.env.PORT ?? "8787";

export default defineConfig({
  plugins: [stripDevMessages(), solid(), VitePWA(pwaOptions)],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});
