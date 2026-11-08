# poukaz2payme

Scan a Slovak "Poštový poukaz na účet" in the browser. The app gives a payme link and a
PAY by square QR code for a bank app.

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

Always compare the result with the form before you pay. OCR can read a field incorrectly.
A field that needs attention has a flag and a note.

## Development

```bash
npm ci
npm test
npm run dev
```

`npm run build` writes a static site to `dist/`. Serve it from any path over HTTPS. The
camera needs a secure context. Without HTTPS only the file input works.

## Publish

The `ci` workflow runs the tests and the build on each push. It deploys to GitHub Pages
only when the repository is public, so it skips the deploy while the repository is private.

To publish:

1. Make the repository public.
2. Enable Pages with the workflow as the source:
   ```bash
   gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow
   ```
3. Run the workflow again:
   ```bash
   gh workflow run ci
   ```
