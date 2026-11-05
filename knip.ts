import type { KnipConfig } from "knip";

const cssImports = (text: string) =>
  [...text.matchAll(/@import\s+["']([^"']+)["']/g)].map(([, path]) => `import "${path}";`).join("\n");

export default {
  entry: ["alchemy.run.ts", "scripts/*.ts", "src/client/lab/lab.ts", "src/client/styles.css", "src/server/testing/dev-fake.ts"],
  project: ["src/**/*.{ts,css}", "*.ts"],
  compilers: { css: cssImports },
} satisfies KnipConfig;
