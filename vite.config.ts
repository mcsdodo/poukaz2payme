import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"),
  },
  worker: { format: "es" },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
