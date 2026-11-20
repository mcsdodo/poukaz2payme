// Runs real photos of poukaz forms through the built app, in a headless browser, and
// compares every field with what the form prints. The photos are personal data and live
// outside this repository: see TESTING.md.
//
//   npm run test:photos              all photos
//   npm run test:photos -- glove 08  only photos whose file name contains one of these
//
// A payment field (IBAN, amount, VS, KS, SS) that is filled but wrong fails the run: that
// is money sent with the wrong data. An empty field, or a wrong name or message, is
// reported but does not fail: the app flags those for the user to check.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(process.env.POUKAZ_PHOTOS ?? join(root, "..", "poukaz2payme-photos"));
const truthFile = join(dir, "truth.json");
if (!existsSync(truthFile)) {
  console.log(`No test photos at ${dir} (no truth.json). See TESTING.md; set POUKAZ_PHOTOS for another folder.`);
  process.exit(0);
}
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("No build in dist/. Run `npm run build` first (npm run test:photos does).");
  process.exit(1);
}

const only = process.argv.slice(2);
const { photos } = JSON.parse(readFileSync(truthFile, "utf8"));
const chosen = photos.filter((p) => !only.length || only.some((s) => p.file.includes(s)));

const PAYMENT = ["iban", "amount", "vs", "ks", "ss"];
const FIELDS = [...PAYMENT, "name", "message"];
const INPUT = { iban: "f-iban", amount: "f-amount", vs: "f-vs", ks: "f-ks", ss: "f-ss", name: "f-name", message: "f-message" };
const norm = {
  iban: (s) => s.replace(/\s/g, "").toUpperCase(),
  name: (s) => s.trim().replace(/[\s,;.]+$/, ""),
};
const same = (key, a, b) => (norm[key] ?? ((s) => s.trim()))(a) === (norm[key] ?? ((s) => s.trim()))(b);

// Diagnostics hold the photo's data: they go to test-results/, which git ignores.
const out = join(root, "test-results", "photos");
mkdirSync(out, { recursive: true });

const server = await preview({ root, logLevel: "silent", preview: { port: 4179, strictPort: false } });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const context = await browser.newContext();

let right = 0;
let total = 0;
const wrongPayment = [];
const byField = Object.fromEntries(FIELDS.map((k) => [k, { ok: 0, empty: 0, wrong: 0 }]));
for (const photo of chosen) {
  const page = await context.newPage();
  const csp = [];
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) csp.push(m.text());
  });
  await page.goto(url);
  await page.setInputFiles("#gallery-input", join(dir, "photos", photo.file));
  await page.waitForSelector("#view-result:not([hidden])", { timeout: 300_000 });
  const got = await page.evaluate((ids) => {
    const r = {};
    for (const [k, id] of Object.entries(ids)) r[k] = document.getElementById(id).value;
    r.diag = document.getElementById("diag").textContent;
    return r;
  }, INPUT);
  writeFileSync(join(out, `${basename(photo.file).replace(/\.[^.]+$/, "")}.diag.json`), got.diag);
  const misses = [];
  for (const k of FIELDS) {
    if (!(k in photo.expect)) continue;
    total++;
    const state = same(k, got[k], photo.expect[k]) ? "ok" : got[k].trim() ? "wrong" : "empty";
    byField[k][state]++;
    if (state === "ok") right++;
    else misses.push(`${k} ${state}${state === "wrong" ? `: ${JSON.stringify(got[k])}, want ${JSON.stringify(photo.expect[k])}` : ""}`);
    if (state === "wrong" && PAYMENT.includes(k)) wrongPayment.push(`${photo.file}: ${k}`);
  }
  const ms = (() => {
    try {
      return JSON.parse(got.diag).totalMs;
    } catch {
      return undefined;
    }
  })();
  console.log(`${misses.length ? "✗" : "✓"} ${photo.file}${ms ? ` (${(ms / 1000).toFixed(1)} s)` : ""}`);
  for (const m of misses) console.log(`    ${m}`);
  for (const c of csp) console.log(`    CSP: ${c}`);
  await page.close();
}

await browser.close();
await new Promise((done) => server.httpServer.close(done));

console.log(`\n${right}/${total} fields right on ${chosen.length} photos. Diagnostics in test-results/photos/.`);
for (const k of FIELDS) {
  const f = byField[k];
  console.log(`  ${k.padEnd(8)} ${f.ok} ok, ${f.empty} empty, ${f.wrong} wrong`);
}
if (wrongPayment.length) {
  console.log(`\nWrong payment fields:\n  ${wrongPayment.join("\n  ")}`);
  process.exit(1);
}
