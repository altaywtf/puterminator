import { defineConfig } from "vitest/config";

// Pure logic on Node; keeps the Foldkit and Alchemy plugins out of the test run.
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
