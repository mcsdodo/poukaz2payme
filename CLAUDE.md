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

## Camera: the live view aims, a photo is what OCR reads

A video frame puts the whole form at about 1000 px (a portrait 1080 px stream, guide frame
at 90% of its width). On the real form that lost VS and KS; the same form at 1930 px read
everything. So OCR never gets a plain video frame when a photo is possible:

- **Chrome on Android (`ImageCapture`):** the stream finds the code, the shot fires when it
  reads twice in a row at the same place (`isSteady`), and `takePhoto` asks for the largest
  size from `getPhotoCapabilities`. The photo must contain the code too; if not (phone
  lowered during the shutter lag), the video frame where the code read is used.
- **Landscape:** on a phone the camera tap goes fullscreen and locks landscape
  (`enterLandscape` in [main.ts](src/main.ts)): the form fills about 1700 px of a 1920 px
  stream instead of 1000. Chrome locks only in fullscreen, and fullscreen needs the tap, so
  it is requested before any await. Every other view unlocks and leaves fullscreen
  (`show`). Safari has no lock; a refusal leaves the camera as it is, and
  `diag.camera.orientation` says which. The manifest has no `orientation`, because
  `portrait` kept an installed app from turning. Headless Chromium with `isMobile` accepts
  the lock but does not turn the viewport, so check the turn on a real phone.
- **Safari, Firefox, any phone without `ImageCapture`:** "Skenovať kamerou" opens the
  phone's camera app (`<input capture>`), which gives a full photo. There is no live view.
- **Fallbacks:** after 8 s without a code, the camera view offers the camera app; a live
  shot that misses VS or amount offers it on the result screen. A browser opens the camera
  app only from a tap, so both are buttons. The stream is stopped first: an iPhone cannot
  share the camera.
- In a portrait 1080x1920 stream the code is about 460 px wide, under 2 px per bar, and
  zxing never read it. `decodePoukaz` in [main.ts](src/main.ts) decodes again at 2x when an
  image under 2400 px has no poukaz code; at 1.5x it already read.
- `diag.capture` says which path took the image (`takePhoto WxH`, `video ...` with the
  reason, or `file`). zxing alone is flaky at video resolution (the photo at 70% size did not
  decode, at 60% it did); Chrome on Android uses its native detector first.
- Test with Chromium's fake camera: `--use-fake-device-for-media-stream
  --use-file-for-fake-video-capture=form.y4m` (make the y4m with ffmpeg from a photo).

## Recognition: what is solid and what is a guess

- **Deskew ([deskew.ts](src/deskew.ts)):** the photo is turned by the barcode corners in quarter
  turns, then by the tilt measured on the reading zone. zxing's corners for a 1D code are two
  horizontal scan lines and carry no tilt, and the bars lean up to half a degree away from the
  text rows when the paper is photographed at an angle. So `zoneSkew` projects the vertical
  gradient of the zone onto rows and takes the sharpest profile. On the real photo turned by
  known angles it was within 0.06 degrees. zxing stops decoding past about 4 degrees.
- **Lighting ([light.ts](src/light.ts)):** Tesseract binarizes the page at one threshold, so
  the soft shadow of a phone over the form went solid black and OCR read almost nothing from
  that half. `flattenLight` divides each pixel by the local paper brightness (block maximum,
  max filter, blur). The cell pass reads the same flattened color image.
- **Form crop:** after deskew the form is cut out by the barcode corners (the form is about
  2.05 code widths wide) from the input at full size and scaled so the form is 2200 px wide.
  `diag.formCrop` shows it. A form at 1000 px lost almost every field; the same frame
  upscaled read most of them. Tesseract still varies with scale: one size loses the stub
  amount, another the KS, so the readings below back each other up.
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
  weights gave `ok`.
- **Verified against the spec only (product 36, 50 digits):** the worked mod-11 example in
  section 3.2 of Slovenská pošta's [Technické parametre](https://www.posta.sk/files/683817a52117f774bfbf4433/technicke-parametre-postovy-poukaz-na-ucet-a-postovy-poukaz-na-adresu.pdf)
  parses with the right fields and check digit (unit test). The spec's field tables
  (section 3.3) define all five layouts. Product 37 and the 48-digit product 36 have
  neither a real sample nor a spec example. With no real form outside product 38, mod-11
  is still a signal and never blocks.
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
    When the boxed cents fail too, two digits under the stub's `cent` label stand in
    (`centsBelowLabel`).
  - On one real form the stub VS was printed on the rule between the VS and SS rows. OCR
    split it into two short lines and took the lower one as an SS. A stub value line shorter
    than 0.8 of its label is a fragment and is skipped. The rule under the stub amount can
    read as a trailing dot (`=37.`, `50.`).
  - A boxed field that page OCR cannot read goes to the cell pass ([cells.ts](src/cells.ts),
    `ocrBoxedDigits`): it isolates each printed character and reads it alone. A result counts
    only when every character has confidence >= 70, and only with enough characters: 4 for KS
    (it prints leading zeros), 2 for VS and SS. A smaller photo gave a confident VS `1` for
    112606 when one shape survived the threshold. A shape under 0.7 of the tallest is a piece
    of the label or the next box, not a digit. The crop is scaled to 230 px tall: at a fixed
    3x a small photo gave 54 px digits and a clean `1` read as `4` at 90.
  - The digit pass under the SUMA label must agree with the amount in words (it once gave
    `1` at confidence 17 for 37 in words), or have confidence >= 60 without words.
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
