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
  code alone (`layoutFromCode`, `CODE_BOX`): VS, KS and SS are then not read (the SS grid
  sat a row low once and read the reference number, VS came out `128101`). A soft photo prints grey, so the
  cell threshold moves up when the crop has contrast but no ink below it.
- A small photo (under 2400 px) with no decodable code is decoded again at 2x
  (`decodePoukaz`): at 460 px across the code zxing never read it, at 1.5x it did.
- **A located code is rescued (`rescueCode` in [main.ts](src/main.ts)):** cut out with a
  margin, scaled so the code is 1700 px wide, contrast stretched and sharpened (unsharp
  mask, amount 2), it decoded on a soft 3200x1800 photo where the whole photo gave nothing,
  and that photo had no IBAN at all before. On a dark photo with motion blur the bars stayed
  smeared, but the digits under them read exactly in Tesseract's block mode (line mode gave
  nothing, sparse mode split them). `poukazFromDigitLine` ([poukaz.ts](src/poukaz.ts)) takes
  48 or 50 of them only with a valid IBAN, and the other fields only when mod-11 holds too:
  one misread 6 in the amount digits passed the IBAN check and gave 6000,00. The rescue
  gives data only; the form is still cut by the located box (cut by the rescued corners,
  the soft photo lost its amount to page OCR). `diag.barcodeRescue` shows the tries.
- `diag.capture` is `file`, or the blank-retry note. Chrome on Android uses its native
  barcode detector first, then zxing.
- **Two forms in one photo:** a photo of one form often shows the edge of another with its
  code whole and its fields cut off, and zxing listed that code first: the scan read only
  the IBAN. Of several poukaz codes the one whose form (a code width above it, 0.85 left,
  0.2 right) lies most inside the photo wins (`formShareInFrame` in [deskew.ts](src/deskew.ts)),
  on a tie the wider code. `diag.formInFrame` lists the shares.

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
  message is read from its boxes (below); the template's `messageArea`, read from page OCR
  at confidence >= 40, is only the fallback.
- **Fixed field boxes (`FIELDS` in [layout.ts](src/layout.ts)):** VS, KS, SS, the amount
  and the two message rows are read from where the form prints them, mapped by the template fit, not
  searched for next to their labels (`readFixedFields` in [main.ts](src/main.ts)). Each is a
  grid: first box, pitch, count. They were measured on two real photos straightened by the
  fit (box separators and character centers; the photos agreed within 6 px). To measure
  again: map the template's corners with `fitLayout(...).map`, warp the flattened image
  with the inverse affine, and find the box separators as columns of higher greenness. The
  fit is off by up to a quarter box, so `gridTiles` ([cells.ts](src/cells.ts)) first moves
  the grid to where the printed characters are (median offset of the letters from the box
  middles), then gives every shape to the box its middle falls in, which keeps an accent
  with its letter and leaves the next field's digits (KS's 0) out. What made the message read:
  - **The band moves onto the characters (`rowShift`).** On a photo taken at an angle the fit
    sat a third of a box low: the amount's band took in the SLOVOM label, whose six small
    letters outnumbered the four digits and moved the grid a box sideways (`2,09` for
    20,90, with no warning), and KS digits printed high were cut at the band's top. The
    row's middle is the ink-weighted middle of the shapes at least a third of a box tall
    within half a box of the band (box characters print at about half the box, labels at a
    quarter); the band moves by it when that is over a tenth of a box, at most 0.4. The
    crop reaches half a box above and below for it. The half-box limit keeps an empty SS
    grid off the reference number under it.
  - Rules: a letter standing on a rule or crossed by the column's border merged with it and
    was dropped as a line (A, R, H). Colour does not separate them after `flattenLight`
    (the rule was as grey as the print on one photo), shape does: ink runs longer than 1.2
    boxes across or 0.9 down, columns or rows mostly ink, and thin bars much taller than
    the row's letters are erased, and everything outside the row's band is cut off.
    Across, a run follows the ink a pixel up or down and over gaps of 2 px: a slightly
    slanted rule broke into pieces too short to erase, and they stayed on the letters
    standing on it (`B___`, an underlined U). Only the pieces of a row's own ink at least
    half the limit long go, so a letter's foot touching the rule stays. Down, runs stay
    strict: tolerant, a faint box separator took the stems of B and P with it.
  - The column's border is green and pale, so it breaks into short runs and survives where
    it crosses a letter (an O 82 px tall in a row of 47 px capitals, read Ó). A shape over
    1.3 times the row's height loses thin tails (a few px wide, at least a tenth of a box
    long) at its top and bottom, if a letter's height is left (`trimTails`). A shape that
    starts below the middle of the row's letters is the label under the row (Č of ČÍTACIA
    ZÓNA under a message printed low).
  - Small marks count only where print puts them: an accent above a letter (7x8 px), a
    hyphen as a flat dash, a comma or full stop at the letters' foot in the box after a
    letter, and punctuation only next to a letter. A letter is at least 0.6 of the row's
    usual height. The caron of ľ, ť, ď and Ľ prints as an apostrophe beside the letter's
    top: it is kept out of the tile and added after (`isApostrophe`; `Veľké` read `Velké`).
    Ť and Ď print theirs above, so a speck beside a T is no caron. Digit grids keep no
    marks: a speck at a 0's foot joined it as `0.` and the box read nothing.
  - Each letter is read alone (`ocrGridText` in [ocr.ts](src/ocr.ts)). Alone, Tesseract
    cannot tell `c o s v w x z` from their capitals, so the height decides; it returns
    nothing for a bare bar, so a one-shape bar is `l` or `I` by its neighbours (`Malé`,
    `RICH`); it reads `é` as `e`, so a mark above the letter adds an acute to a vowel and a
    caron to a consonant (`accented` in [text.ts](src/text.ts)). The rows join without a
    space (`RICH` + `ARD`); an empty box is a space. `U`/`u` also go by height (a clean U
    read `u` at 90), a `p` standing on the line is `P`, and a `0` between letters is `O`.
  - **Tesseract reads one letter differently at each size.** At the tile's own size (capitals
    about 47 px) it gave `K` for k and nothing for P and E; at 0.7 it read them, at 0.5 a P
    came out D, at 0.4 `p`. On 53 letters of three photos: full size 44 right, 0.7 48,
    0.5 48, 0.4 49. So `readLetter` reads at 0.7 and 0.5, and at 0.4 when those two differ,
    and takes the letter most sizes give. A digit no page mode reads (a clean 0 got nothing
    in all three) is read again at half the size, where it read 0 at 95 (`readCell`).
  - **The message's second row runs on past its 12 boxes.** The first row breaks after 12
    characters and the second prints the rest, over the column's border (`UJZA PETREKOVÁ`,
    14), so it is read 6 boxes further. The extra boxes count only when the 12th box holds
    a character and the 13th a letter, and only while the letters run on unbroken; the
    border meeting the rule under the row read `J.` there. A row that does not run on is
    read again in its own 12 boxes: the wider crop moves the ink threshold, and a B on the
    rule read R.
  - Digits use the same grid at three thresholds, voted per box (`ocrGridDigits`). Where
    the grid read part of a field (`112?13`), the label-based fallback must fit that
    pattern: on a 970 px frame it read `1126130`. The euros are the run of boxes that ends
    at the last euro box: a stub of the field's left border, three empty boxes left of the
    `=`, read as an unreadable box and emptied the amount.
  - A grid one box out leaves its stray character within a box of its end, so only ink that
    close counts as outside: K. SPRAC.'s `3` stands 1.4 boxes right of the amount's cents.
  - **The grid can land a whole box out.** The nudge picks the nearest box, so a fit off by
    about half a box (15 px on a portrait photo) put the VS/KS grid one box left: VS read
    `11261`, KS `3017`. So VS and KS are read as one row of 14 boxes (they print as one; KS
    fills its 4), the crop reaches 1.6 boxes past the grid, and `gridTiles` also tries one box
    left and right and keeps the placement that leaves no character-shaped ink outside. Only
    character-shaped ink counts: the KS bracket's stroke `┐` once pulled the grid a box the
    wrong way. The first threshold places the grid and the others keep it (`gridOffset`):
    placed on their own, two readings sat a box apart and the vote mixed them.
  - A letter clearly taller than the row's capitals (Š at 55 px against 44) carries its
    accent even when it touches the letter. A hyphen must sit at mid-letter height (a flat
    scrap of a rule at the foot read as one). A bare bar, or an unreadable box, with nothing
    on either side is a stub of a rule, not a letter.
  - Placed by the barcode alone, VS, KS and SS are not read (a soft shot gave VS `128101`),
    and a message with more than a tenth of its boxes unreadable is dropped.
  - The name's copies are still found by their labels: a fixed box around both copies
    picked up the address's second line when the fit was off. Only the middle copy's first
    line is re-read from a fixed box (`FIELDS.middleName`), kept tight to that line.
  - On both photos at all sizes the message reads `MŠ-Malé,RICHARD LAČNÝ`, except at
    1300 px (two accents lost, the marks are a few pixels). With the form at 970 px it is
    garbled, and VS is left empty rather than wrong.
  - Three more photos (3000x4000, two forms in each, one held down by fingers over the
    code's digits, one at an angle) read every IBAN, amount, VS, KS and SS at full size, at
    1600 px and turned a quarter or upside down; at 1200 px one VS is left empty. Two of the
    three messages read exactly; on the third the second row prints on the rule and its E
    loses its foot (`PFTREK`). Test copies of a photo must apply its EXIF orientation first
    (these are stored 4000x3000 with orientation 6): resized without it, every copy failed.
  - Eleven distinct real photos in all (five of one form at different light and distance,
    one other school's form in a typewriter-like font) read 69 of 77 fields; the build
    before read 55, with two wrong amounts and no warning (140,00 for 40,00, 3171510,00 for
    37,50). None of the misses is a wrong payment value: a dark photo leaves amount, VS and
    KS empty (placed by the code alone), and the rest are message letters or a missing
    accent. The typewriter form printed its message over the label above the boxes; it
    read `-?-VÉ č-`, so a box message under 70% letters and digits is dropped. OCR read its
    Š as `$`, which the name vote now reads as Š; Í, read `í`, goes by height like U.
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
- **The boxes are the source of truth; the stub only copies them.** With a template fit:
  - VS and KS come from their 14 boxes; the stub's VS is shown as a note when it differs,
    and stands in, flagged, only when the boxes cannot be read.
  - SS comes from its boxes alone. The stub's SS is never used, even without a fit (only
    the rightmost SS label, right of the stub's quarter, is searched): the stub prints VS on
    the rule between its VS and SS rows, and it was read as an SS. An empty grid is an empty
    SS, which most forms have.
  - The amount comes from its boxes (`FIELDS.amount`: 6 euro boxes with the `=`, 2 cent
    boxes, as one row; no digit is wider than tall, so the `=` is skipped). The stub's
    `=37 50` is the fallback and a note. When the two differ, the amount in words decides.
  - The name: the middle ADRESÁT block is the payee's copy, printed larger and clear of
    rules. Its readings count 1.5 times in the vote, and its first line is re-read from the
    template's box (`FIELDS.middleName`, y 699-732; the second line starts at 733): OCR
    merged the two lines into one 85 px line, and a re-read of that read nothing.
  - `ex.fixed` names the fields read from boxes alone; the label search's cell pass leaves
    them be.
- **Heuristic, in the order [extract.ts](src/extract.ts) tries them** (without a fit, and as
  fallbacks):
  - The left stub repeats VS, amount, IBAN and name as plain text, and OCR reads it far
    better than the boxed copy by page OCR. So for VS and the amount the leftmost label goes
    first, and its value is on the same row, right of the label.
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
  - Without a template fit, a boxed field that page OCR cannot read goes to the cell pass
    ([cells.ts](src/cells.ts), `ocrBoxedDigits`), aimed by its label: it isolates each
    printed character and reads it alone. With a fit the grids above do this job. A result counts
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
- **Not solved:** the amount boxes read on 5 of 8 test images; on the rest the stub's copy
  stands in, checked by the words. There is no perspective correction: the affine template fit absorbs a mild keystone, about 10 px on
  the real photo, and the grid's offset step absorbs the rest along a row. The page OCR's
  message (from `messageArea`) stays only when the boxes give fewer than 2 letters.

The result screen's photo panel has "Uložiť fotku": it saves the image the scan read
(`state.source`) as a JPEG, through the share sheet on a phone. A
form that read badly can then be sent along with the diagnostics and added as a test.

The result screen has a "Diagnostika" panel (raw barcode digits and corners, variant,
checksums, tilt, template fit, OCR lines, timings). The OCR lines are after deskew; the
existing fixture is from before deskew, so it is tilted by 1.78 degrees. To add a failed form as a test, copy `ocrLines` into
[test/fixtures/](test/fixtures/) and replace all personal and payment data with fake values
of the same shape, as the existing fixture does.
