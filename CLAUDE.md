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
package versions, so a deploy keeps the 15 MB unless Tesseract changed. There is no automatic
`skipWaiting`: an open page keeps its old files, and the new version runs on the next start.

GitHub Pages sends `max-age=600` on every file, `sw.js` and `index.html` included. A plain
`fetch` in the worker uses that HTTP cache, so for 10 minutes after a deploy, opening the
app gave the old `index.html` and the old bundle (a reload revalidates, so a reload test
hides this). So the page fetch uses `cache: "no-cache"`, the precache `cache: "reload"`, and
the registration `updateViaCache: "none"`. An installed app reopened from the recent apps
list only resumes and never reloads, so the page calls `registration.update()` when it comes
to the front and shows "Je pripravená nová verzia" when a worker waits; its button sends
`skip-waiting`, and `controllerchange` reloads. To test it, serve two builds with
`max-age=600` in turn and open the page with a new navigation, not `reload()`.
`npm run dev` has no service worker. To test offline, build, `npx vite preview`, load once,
then stop the server and reload.

The icons in `public/icons/` are rendered from `icon.svg` by `node scripts/make-icons.cjs`.

Do not run `npm run build` while `npm run dev` runs. `copy-assets.mjs` rewrites
`public/vendor`, and the dev server then returns HTML for the worker file. The error is
`Unexpected token '<'`.

## Camera: the phone's camera app takes the photo

**A browser cannot take a photo of the camera app's quality.** It gets the video pipeline:
1080p or 4K single frames, video noise reduction that smears print, stabilization that
crops, on some phones another lens. `ImageCapture.takePhoto` is a thin extra on that stream:
the sensor's field of view, but none of the multi-frame processing (HDR, night mode,
sharpening) the camera app does, and often softer than the frame. Camera app photos of the
real form read every field; live shots of the same form read little.

So "Odfotiť poukaz" is `<input type="file" capture="environment">`: on a phone it opens the
camera app and hands the full photo back, on a computer it is a file picker. "Z galérie" is
the same input without `capture`. A scan that misses VS or the amount offers the camera
again on the result screen (phones only; a browser opens the camera app only from a tap).

There is no live view. One existed up to 0.5.x (a `getUserMedia` stream, an automatic shot
when the barcode read twice at one place, an `ImageCapture` still, a landscape lock); it was
removed because every image it could produce read worse than a camera app photo, and it
caused most of the camera trouble. Two things learnt from it still matter for photos:

- **Canvas memory on a phone:** Chrome on Android does not throw when canvas memory runs
  out; the canvas comes out blank, and a scan then fills only the IBAN (the barcode is read
  from a 2400 px copy, the level full-size copy is blank, `layout: no fit`). The pipeline
  frees each copy when the next is made (`release`, `swap`) and checks the OCR image with
  `isBlank`: a blank one is read again once at 60% of the size, and `diag.capture` says so.
  Reproduce it in Chromium by making `drawImage` a no-op on canvases over 8 MP.
- **A code too soft to decode** is still found by its look ([locate.ts](src/locate.ts):
  the one wide flat band of steep edges across and none down; within 3 px of zxing's ends on
  a sharp photo at 1000 px). The form is then cut out and read, the IBAN can come from the
  digits under the bars, and with too few labels for a fit the template is placed by the
  code alone (`layoutFromCode`, `CODE_BOX`): VS and KS are then flagged, SS is skipped (the
  grid sat a row low once and read the reference number). A soft photo prints grey, so the
  cell threshold moves up when the crop has contrast but no ink below it.
- A small photo (under 2400 px) with no decodable code is decoded again at 2x
  (`decodePoukaz`): at 460 px across the code zxing never read it, at 1.5x it did.
- `diag.capture` is `file`, or the blank-retry note. Chrome on Android uses its native
  barcode detector first, then zxing.

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
- **Fixed field boxes (`FIELDS` in [layout.ts](src/layout.ts)):** VS, KS, SS and the two
  message rows are read from where the form prints them, mapped by the template fit, not
  searched for next to their labels (`readFixedFields` in [main.ts](src/main.ts)). Each is a
  grid: first box, pitch, count. They were measured on two real photos straightened by the
  fit (box separators and character centers; the photos agreed within 6 px). To measure
  again: map the template's corners with `fitLayout(...).map`, warp the flattened image
  with the inverse affine, and find the box separators as columns of higher greenness. The
  fit is off by up to a quarter box, so `gridTiles` ([cells.ts](src/cells.ts)) first moves
  the grid to where the printed characters are (median offset of the letters from the box
  middles), then gives every shape to the box its middle falls in, which keeps an accent
  with its letter and leaves the next field's digits (KS's 0) out. What made the message read:
  - Rules: a letter standing on a rule or crossed by the column's border merged with it and
    was dropped as a line (A, R, H). Colour does not separate them after `flattenLight`
    (the rule was as grey as the print on one photo), shape does: ink runs longer than 1.2
    boxes across or 0.9 down, columns or rows mostly ink, and thin bars much taller than
    the row's letters are erased, and everything outside the row's band is cut off.
  - Small marks count only where print puts them: an accent above a letter (7x8 px), a
    hyphen as a flat dash, a comma or full stop at the letters' foot, and punctuation only
    next to a letter. A letter is at least 0.6 of the row's usual height.
  - Each letter is read alone (`ocrGridText` in [ocr.ts](src/ocr.ts)). Alone, Tesseract
    cannot tell `c o s v w x z` from their capitals, so the height decides; it returns
    nothing for a bare bar, so a one-shape bar is `l` or `I` by its neighbours (`Malé`,
    `RICH`); it reads `é` as `e`, so a mark above the letter adds an acute to a vowel and a
    caron to a consonant (`accented` in [text.ts](src/text.ts)). The rows join without a
    space (`RICH` + `ARD`); an empty box is a space.
  - Digits use the same grid at three thresholds, voted per box (`ocrGridDigits`). Where
    the grid read part of a field (`112?13`), the label-based fallback must fit that
    pattern: on a 970 px frame it read `1126130`.
  - The name stays label-based with the vote: fixed name boxes picked up the address's
    second line when the fit was off.
  - On both photos at all sizes the message reads `MŠ-Malé,RICHARD LAČNÝ`, except at
    1300 px (two accents lost, the marks are a few pixels). At 970 px (a portrait video
    frame) it is garbled, and VS is left empty rather than wrong.
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
    3x a small photo gave 54 px digits and a clean `1` read as `4` at 90. Even at 230 px a
    clean, well cut `1` read as `4` at 84, so the shape decides too: a printed `1` is about
    0.35 as wide as tall, every other digit 0.6 or more. A shape under 0.45 read as anything
    but `1` tries the other page modes and is unreadable when none says `1`.
  - An added label is off by up to two label heights on a photo taken at an angle (the
    stub ADRESÁT 40 px low, on the first address line, so the name became the town). Under
    an added label, a line counts once its middle is below the label's top, and a line that
    shares 4 letters with the label is OCR's own garbled reading of it and is skipped.
    [test/fixtures/poukaz-real-form-2.lines.json](test/fixtures/poukaz-real-form-2.lines.json)
    is that photo, after deskew.
  - The stub's name line needs 5 letters or a space: OCR split `ADRESÁT` and its `SÁT`
    scrap was taken as the name, with the real line (confidence 92) right under it, and the
    vote then had nothing good to work with.
  - **Name vote ([vote.ts](src/vote.ts)):** the payee's first line is printed twice (the
    stub and the middle ADRESÁT block, `nameCopies`), and `ocrLine` reads each copy again
    from its own crop, so there are up to four readings. They are aligned letter by letter to
    the middle one, and each place takes the choice with the most confidence. Readings
    further than 0.4 from the middle one are of another line and are left out. One photo gave
    `SF OJENÁ`, `ŠSPOJENÁ`, `"SPOJENÁ` and `[5 JENA`; the vote gave `SPOJENÁ`. What made it
    work: box marks and quotes are dropped first; a letter for a space costs more than an
    insertion, so a split word does not lose a letter; and an accent wins unless the plain
    letter has more than twice its weight, because OCR drops accents far more often than it
    adds them. Readings stop early (OCR split the line, or read it only to `MARKU`): the
    alignment skips either end of the frame at half a letter's cost (free, it skipped
    misread letters instead), a skip of 3 or more does not vote, and the frame is a reading
    that reaches further than the middle one. At the line's two ends a letter some readings
    lack wins unless its absence has twice its weight (a cut stub loses the first letter).
    `joinRow` joins the pieces of a split line and stops at a label (`MENO` stands right of
    the middle copy). `diag.nameVote` lists the readings.
  - **Thresholds vote ([cells.ts](src/cells.ts), `voteCells`):** a threshold can change a
    shape (at 0.4 a printed 6 read as a confident 5; 0.5 read 6), so the first complete
    reading is not trusted alone. Two complete readings that agree (and are plausible) end it;
    otherwise all three are read and each place takes the majority, a tie is unreadable. A
    place fewer than half the readings saw is dropped only when two complete readings agree
    without it: thresholds lose real digits too (0.5 read KS `017`, 0.6 `0179`). The VS crop
    stops at the KS label, or it took KS's first `0` as a seventh VS digit.
  - **Edges:** the form crop is drawn on white where it reaches past the photo, so text at
    the photo's edge does not touch the image border.
  - The digit pass under the SUMA label must agree with the amount in words (it once gave
    `1` at confidence 17 for 37 in words), or have confidence >= 60 without words.
- **Tesseract traps:** a character tile needs a wide white margin (at 14 px a clean `9`
  returned nothing), and each page mode returns nothing for some clean characters, so
  `ocrBoxedDigits` tries three modes per character.
- **Not solved:** the boxed euro digits read as nothing, so the words stand in. There is no
  perspective correction: the affine template fit absorbs a mild keystone, about 10 px on
  the real photo, and the grid's offset step absorbs the rest along a row. The page OCR's
  message (from `messageArea`) stays only when the boxes give fewer than 2 letters.

The result screen's photo panel has "Uložiť fotku": it saves the image the scan read
(`state.source`, the live shot or the file) as a JPEG, through the share sheet on a phone. A
form that read badly can then be sent along with the diagnostics and added as a test.

The result screen has a "Diagnostika" panel (raw barcode digits and corners, variant,
checksums, tilt, template fit, OCR lines, timings). The OCR lines are after deskew; the
existing fixture is from before deskew, so it is tilted by 1.78 degrees. To add a failed form as a test, copy `ocrLines` into
[test/fixtures/](test/fixtures/) and replace all personal and payment data with fake values
of the same shape, as the existing fixture does.
