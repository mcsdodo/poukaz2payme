# poukaz2payme

Scan a Slovak "Poštový poukaz na účet" in the browser. The app gives a payme link and a
PAY by square QR code for a bank app.

**Open the app: <https://mcsdodo.github.io/poukaz2payme/>**

The barcode decode and the OCR run in the browser. No image leaves the device. The app has no server, and a Content Security Policy in `index.html` blocks
requests to other origins.

## What it reads

The boxes on the right part of the form are the source of truth. The left part only copies
them, so it is a fallback and a cross-check.

| Field | Source |
|---|---|
| IBAN | Code 128 barcode, accepted when it passes mod-97. OCR of the printed IBAN is the fallback. |
| Amount | The SUMA boxes, then the left part's copy. The amount in words checks both and decides when they differ. |
| VS | The VS boxes, one digit at a time. The left part's copy fills in, flagged, only when the boxes can't be read. |
| SS | The SS boxes only. Most forms leave them empty. |
| KS | The KS boxes, one digit at a time, checked against the known KS classes |
| Name | The first line of the middle ADRESÁT block, voted with the left part's copy |
| Message | The SPRÁVA PRE ADRESÁTA boxes, one letter per box, both rows joined |

Always compare the result with the form before you pay. OCR can read a field incorrectly.
A field that needs attention has a flag and a note.

The result gives a link that opens the payment in a bank app, a share button where the
browser has one, and a PAY by square QR that can be saved as an image.

After the first scan the app works offline, and it can be added to the home screen.

"Odfotiť poukaz" opens the phone's camera app and reads the photo it takes; "Z galérie"
reads a photo already on the phone. There is no live camera view: a browser only gets a
video feed, and its frames read far worse than a camera app photo. For a good scan, get the
whole form in the frame, close and sharp, without a shadow across it. Upright or sideways
does not matter.

## Development

```bash
npm ci
npm test
npm run dev
```

`npm run build` writes a static site to `dist/`. Serve it from any path. Over HTTPS the
service worker works offline; the scan itself only needs the file input.

## Publish

The `ci` workflow runs the tests and the build on each push. A push to `main` also deploys
the site to GitHub Pages.

## License

[MIT](LICENSE). The bundled libraries keep their own licenses: Apache-2.0 and MIT for the
code, and OFL-1.1 for the IBM Plex fonts.
