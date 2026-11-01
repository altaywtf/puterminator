import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// `alchemy dev` serves the Worker on :1337; `pnpm dev:client` proxies the Worker routes to it.
const worker = "http://localhost:1337";

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: ["index.html", "privacy.html"] } },
  server: {
    proxy: {
      "/api": worker,
      "/auth": worker,
      "/agent": { target: worker, ws: true },
    },
  },
});
