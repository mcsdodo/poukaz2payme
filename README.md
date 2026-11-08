# poukaz2payme

Scan a Slovak "Poštový poukaz na účet" in the browser. The app gives a payme link and a
PAY by square QR code for a bank app.

**Open the app: <https://mcsdodo.github.io/poukaz2payme/>**

The camera, the barcode decode and the OCR all run in the browser. No image leaves the
device. The app has no server, and a Content Security Policy in `index.html` blocks
requests to other origins.

## What it reads

| Field | Source |
|---|---|
| IBAN | Code 128 barcode, accepted when it passes mod-97. OCR is the fallback. |
| Amount | Printed digits, checked against the amount in words |
| VS, SS | Plain copy on the left part of the form, then the boxed copy |
| KS | Boxed copy, one digit at a time, checked against the known KS classes |
| Name | OCR |
| Message | OCR, from the message boxes of the form |

Always compare the result with the form before you pay. OCR can read a field incorrectly.
A field that needs attention has a flag and a note.

The result gives a link that opens the payment in a bank app, a share button where the
browser has one, and a PAY by square QR that can be saved as an image.

After the first scan the app works offline, and it can be added to the home screen.

On Android in Chrome the live view finds the form and the app takes a full-resolution photo.
On an iPhone, "Skenovať kamerou" opens the phone's camera, because Safari cannot take a
full-resolution photo from a live view, and a video frame is too small for the printed text.

## Development

```bash
npm ci
npm test
npm run dev
```

`npm run build` writes a static site to `dist/`. Serve it from any path over HTTPS. The
camera needs a secure context. Without HTTPS only the file input works.

## Publish

The `ci` workflow runs the tests and the build on each push. A push to `main` also deploys
the site to GitHub Pages.

## License

[MIT](LICENSE). The bundled libraries keep their own licenses: Apache-2.0 and MIT for the
code, and OFL-1.1 for the IBM Plex fonts.
