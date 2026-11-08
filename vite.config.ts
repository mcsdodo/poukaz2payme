import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

const version = (name: string): string =>
  JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf-8")).version;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Writes dist/sw.js from scripts/sw-template.js. The shell cache name is a
 * hash of the shell files, so any change ships a new worker. The vendor cache
 * name carries the Tesseract versions, so a deploy that does not update
 * Tesseract keeps the 15 MB a phone already has.
 */
function serviceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "poukaz-service-worker",
    apply: "build",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const files = walk(outDir)
        .map((p) => relative(outDir, p).split(sep).join("/"))
        // Browsers that run a service worker load woff2, never the woff fallback.
        .filter((f) => !f.startsWith("vendor/") && f !== "sw.js" && !f.endsWith(".woff"))
        .sort();
      const hash = createHash("sha256");
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const vendor = ["tesseract.js", "tesseract.js-core", "@tesseract.js-data/slk", "@tesseract.js-data/eng"]
        .map(version)
        .join("-");
      const sw = readFileSync(new URL("./scripts/sw-template.js", import.meta.url), "utf-8")
        .replace("__SHELL_CACHE__", `shell-${hash.digest("hex").slice(0, 12)}`)
        .replace("__VENDOR_CACHE__", `vendor-${vendor}`)
        .replace("__SHELL_FILES__", JSON.stringify(["./", ...files]));
      writeFileSync(join(outDir, "sw.js"), sw);
    },
  };
}

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"),
  },
  plugins: [serviceWorker()],
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
