// Run by hand after changing icon.svg: node scripts/make-icons.cjs (needs Playwright with Chromium).
// Renders public/icons/icon.svg to the PNG sizes the manifest and iOS need.
const { chromium } = require("playwright");
const fs = require("fs");
const dir = require("path").join(__dirname, "..", "public", "icons") + "/";
const svg = fs.readFileSync(dir + "icon.svg", "utf8");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  // Maskable icons are cut to a circle of 80% diameter: the card corners must fit inside it (0.74).
  for (const [name, size, scale] of [["icon-192.png", 192, 0.82], ["icon-512.png", 512, 0.82], ["icon-maskable-512.png", 512, 0.74], ["apple-touch-icon.png", 180, 0.82]]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px;--s:${scale}}</style>${svg}`);
    await p.screenshot({ path: dir + name, omitBackground: false });
  }
  await b.close();
})();
