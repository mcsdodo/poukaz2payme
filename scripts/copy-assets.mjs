// Copy the Tesseract.js runtime into public/vendor so the app loads it from
// its own origin. The library defaults are jsDelivr URLs.
//   public/vendor/tesseract/worker.min.js
//   public/vendor/tesseract-core/*.wasm.js   (worker picks SIMD / relaxed SIMD / LSTM at runtime)
//   public/vendor/lang/{slk,eng}.traineddata.gz   (4.0.0_best_int: smaller than 4.0.0)
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "public", "vendor");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "tesseract"), { recursive: true });
mkdirSync(join(out, "tesseract-core"), { recursive: true });
mkdirSync(join(out, "lang"), { recursive: true });

cpSync(join(nm, "tesseract.js", "dist", "worker.min.js"), join(out, "tesseract", "worker.min.js"));

const coreDir = join(nm, "tesseract.js-core");
for (const f of readdirSync(coreDir)) {
  if (f.endsWith(".wasm.js")) cpSync(join(coreDir, f), join(out, "tesseract-core", f));
}

for (const lang of ["slk", "eng"]) {
  cpSync(
    join(nm, "@tesseract.js-data", lang, "4.0.0_best_int", `${lang}.traineddata.gz`),
    join(out, "lang", `${lang}.traineddata.gz`),
  );
}
console.log("vendor assets copied to", out);
