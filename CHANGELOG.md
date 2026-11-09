# Changelog

## [2026-11-09]

### Added
- camera: on Android the live view goes fullscreen and turns to landscape, where the form is larger in the frame

### Fixed
- camera: the photo is taken without flash, and the camera turns off right after the shot
- ocr: boxed digits are voted across thresholds, so one misread threshold no longer gives a wrong VS or KS
- ocr: the name survives a stub cut by the photo's edge or a line OCR split in two
- ocr: the name is the first address line, not the town, on a photo taken at an angle
- ocr: the name is read from both printed copies and voted letter by letter, so a misread letter or a lost accent is corrected
- ocr: a boxed 1 no longer reads as 4
- app: a new version shows when the app is opened again, and an open app offers to update
- ocr: a shadow over the form no longer blacks out half of it; the light is evened out before OCR
- ocr: the form is cut out by the barcode and scaled to a fixed width, so a photo from a distance reads like a close one
- camera: the live view finds the code in a portrait stream, where it never read before
- ocr: VS, KS and amount read on a form where pieces of labels, a rule through the stub, or dots from the underline got in the way

## [2026-11-08]

### Added
- repo: MIT license and a link to the hosted app on GitHub Pages
- app: scan a poukaz na účet in the browser and build a payme link and a PAY by square QR
