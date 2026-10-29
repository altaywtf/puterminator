import { defineConfig } from "vitest/config";

// Pure logic only; keeps the Cloudflare Vite plugin out of the test run.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
