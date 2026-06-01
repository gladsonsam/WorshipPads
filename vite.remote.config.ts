import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the phone remote into ONE self-contained HTML at
// src-tauri/assets/remote.html. The Rust server embeds that file at compile
// time via include_str! and serves it on `/`. See src-tauri/src/server.rs.
//
// In dev: `npm run dev:remote` serves the remote on :1422 with HMR and proxies
// /api + /ws to the Rust server (running under `tauri dev`). Default Rust
// server port is 7777 (see src-tauri/src/model.rs). Override with
// REMOTE_API_PORT=<n> when you've changed it in Settings.

const apiPort = Number(process.env.REMOTE_API_PORT ?? 7777);
const apiTarget = `http://127.0.0.1:${apiPort}`;
const wsTarget = `ws://127.0.0.1:${apiPort}`;

// Dev-only middleware: rewrites `/` to `/remote.html` so visiting the dev
// server lands on the phone remote instead of the desktop index.html that
// also lives at the project root.
const serveRemoteAtRoot = {
  name: "serve-remote-at-root",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/" || req.url === "/index.html") {
        req.url = "/remote.html";
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [serveRemoteAtRoot, react(), viteSingleFile()],
  build: {
    outDir: "src-tauri/assets",
    emptyOutDir: false,
    rollupOptions: {
      input: "remote.html",
    },
  },
  server: {
    port: 1422,
    strictPort: true,
    host: true,
    proxy: {
      "/api": apiTarget,
      "/ws": { target: wsTarget, ws: true },
    },
  },
});
