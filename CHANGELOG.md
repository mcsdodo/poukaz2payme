# Changelog

## [2026-11-09]

### Fixed
- ocr: a shadow over the form no longer blacks out half of it; the light is evened out before OCR
- ocr: the form is cut out by the barcode and scaled to a fixed width, so a photo from a distance reads like a close one
- camera: the live view finds the code in a portrait stream, where it never read before
- ocr: VS, KS and amount read on a form where pieces of labels, a rule through the stub, or dots from the underline got in the way

## [2026-11-08]

### Added
- repo: MIT license and a link to the hosted app on GitHub Pages
- app: scan a poukaz na účet in the browser and build a payme link and a PAY by square QR
