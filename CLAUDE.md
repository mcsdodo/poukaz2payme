# poukaz2payme

A static web app that scans a Slovak "Poštový poukaz na účet" and gives a payme v2 `/p/` link
and a PAY by square QR. It is hosted on GitHub Pages and has no server.

## Everything is self-hosted, and the CSP enforces it

The libraries load from jsDelivr by default. The app overrides all of them:

| Library | Default | Override |
|---|---|---|
| zxing-wasm | `.wasm` from jsDelivr | Vite bundles `zxing_reader.wasm` to `/assets/`, `locateFile` in [barcode.worker.ts](src/barcode.worker.ts) |
| Tesseract.js | worker, core and traineddata from jsDelivr | [copy-assets.mjs](scripts/copy-assets.mjs) copies them to `/vendor/`, paths in [ocr.ts](src/ocr.ts) |

The CSP is a `<meta>` tag in [index.html](index.html), because GitHub Pages cannot set headers.
It is `connect-src 'self'` and `script-src 'self' 'wasm-unsafe-eval'`. If a library update
brings back a CDN default, the browser blocks the request and the scan fails. Check the browser
console for `Content Security Policy` after any dependency update.

Tesseract loads only the `*.wasm.js` core files (the WASM is base64 inside them) and picks
SIMD, relaxed SIMD or plain at run time, so all of them are copied. `workerBlobURL: false`
keeps the worker same-origin, so the CSP needs no `blob:` in `worker-src`.

## Offline: the service worker

The build writes `dist/sw.js` from [scripts/sw-template.js](scripts/sw-template.js) (plugin in
[vite.config.ts](vite.config.ts)). It precaches the shell (HTML, bundles, woff2, zxing wasm,
about 1.5 MB) and caches `vendor/` on first use, so a phone stores only the Tesseract core it
runs. The shell cache name is a hash of the shell files; the vendor cache name is the Tesseract
package versions, so a deploy keeps the 15 MB unless Tesseract changed. There is no
`skipWaiting`: an open page keeps its old files, and the new version runs on the next start.
`npm run dev` has no service worker. To test offline, build, `npx vite preview`, load once,
then stop the server and reload.

The icons in `public/icons/` are rendered from `icon.svg` by `node scripts/make-icons.cjs`.

Do not run `npm run build` while `npm run dev` runs. `copy-assets.mjs` rewrites
`public/vendor`, and the dev server then returns HTML for the worker file. The error is
`Unexpected token '<'`.

## Recognition: what is solid and what is a guess

- **Deskew ([deskew.ts](src/deskew.ts)):** the photo is turned by the barcode corners in quarter
  turns, then by the tilt measured on the reading zone. zxing's corners for a 1D code are two
  horizontal scan lines and carry no tilt, and the bars lean up to half a degree away from the
  text rows when the paper is photographed at an angle. So `zoneSkew` projects the vertical
  gradient of the zone onto rows and takes the sharpest profile. On the real photo turned by
  known angles it was within 0.06 degrees. zxing stops decoding past about 4 degrees.
- **Form template ([layout.ts](src/layout.ts)):** label positions of the real form after
  deskew. An affine fit maps them onto the labels OCR read (needs 4, usually gets 30), and
  each label OCR missed is added at its predicted place, so extract.ts finds its value as
  usual. A label OCR read always wins. Values found next to an added label get a note. The
  template also gives the message boxes: the message is printed over its label, so it is
  read from the area, at OCR confidence >= 40, and flagged low.
- **Solid:** IBAN from the Code 128C barcode, accepted when it passes mod-97. The payme link
  matches the example in the SBA standard (unit test). PAY by square round-trips through
  `bysquare` decode (unit test).
- **Verified on one real form only (product 38):** the 48-digit barcode layout and the mod-11
  weights gave `ok`. Product 36, 37 and the 50-digit layout have no real sample, so mod-11 is
  still a signal and never blocks.
- **The barcode often holds zeros for VS and amount.** On that form only the IBAN came from
  it, so OCR is the only source for the other fields.
- **Heuristic, in the order [extract.ts](src/extract.ts) tries them:**
  - The left stub repeats VS, amount, IBAN and name as plain text, and OCR reads it far
    better than the boxed copy. So the leftmost label goes first, and its value is on the
    same row, right of the label.
  - The form has no decimal separator. EUR and cent are separate columns, and OCR returns
    them as two lines (`=28`, `50`).
  - The KS label is `KONŠT. SYMBOL`, and KS exists only in boxes.
  - [ks.ts](src/ks.ts) holds the known KS classes (the first three digits). A reading with an
    unknown class makes the cell pass try the next threshold, and if none is better the field
    is flagged low. The list fills one unreadable digit of the first three only when one class
    fits, and flags it. **The list never changes a digit that was read.** The fourth digit is
    the payment method (8 non-cash, 9 cash) and does not depend on the class, and the bank
    lists print only the most used codes: a real form had 0179, the lists have 0178. Snapping
    to a list would turn that correct 0179 into a wrong 0178.
  - The euro part in words (`=Dvadsatosem=`, [amountwords.ts](src/amountwords.ts)) is an
    independent reading. It confirms the digits, flags a mismatch, and, when the digits are
    missing, supplies the euros next to the boxed cents, flagged low. The words hold no cents.
  - A boxed field that page OCR cannot read goes to the cell pass ([cells.ts](src/cells.ts),
    `ocrBoxedDigits`): it isolates each printed character and reads it alone. A result counts
    only when every character has confidence >= 70.
- **Tesseract traps:** a character tile needs a wide white margin (at 14 px a clean `9`
  returned nothing), and each page mode returns nothing for some clean characters, so
  `ocrBoxedDigits` tries three modes per character.
- **Not solved:** the message read from its area is often empty and sometimes wrong (`ŠTRKY`
  for `STRAVNÉ` on one turned copy of the real photo). The boxed euro digits also read as nothing, so the words stand in. There
  is no perspective correction: the affine template fit absorbs a mild keystone, about 10 px
  on the real photo.

The result screen has a "Diagnostika" panel (raw barcode digits and corners, variant,
checksums, tilt, template fit, OCR lines, timings). The OCR lines are after deskew; the
existing fixture is from before deskew, so it is tilted by 1.78 degrees. To add a failed form as a test, copy `ocrLines` into
[test/fixtures/](test/fixtures/) and replace all personal and payment data with fake values
of the same shape, as the existing fixture does.
