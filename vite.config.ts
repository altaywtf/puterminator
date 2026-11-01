import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const alchemyDevWorker = "http://localhost:1337";

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: ["index.html", "privacy.html"] } },
  server: {
    proxy: {
      "/api": alchemyDevWorker,
      "/auth": alchemyDevWorker,
      "/agent": { target: alchemyDevWorker, ws: true },
    },
  },
});
