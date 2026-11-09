# Changelog

## [2026-11-09]

### Added
- ocr: VS, KS, SS, the amount and the message are read from the form's own boxes; the two-line message reads letter by letter, with accents
- app: the photo a scan read can be saved to the phone ("Uložiť fotku")

### Changed
- ocr: the boxes are the source of truth: the left part of the form only stands in or adds a note, and SS is never taken from it
- ocr: the name is voted from both printed copies, leaning on the middle ADRESÁT copy, whose first line is re-read on its own
- app: "Odfotiť poukaz" opens the phone's camera app, whose photos are far sharper than anything a browser can capture

### Removed
- app: the live camera view. Every image it could give read worse than a camera app photo, and it caused most of the camera trouble

### Fixed
- ocr: a shadow over the form no longer blacks out half of it; the light is evened out before OCR
- ocr: a photo from a distance or at an angle reads like a close one; the form is cut out by the barcode and scaled
- ocr: portrait photos read VS and KS right; the box grid no longer lands one box out
- ocr: boxed digits are voted across thresholds, so one misread threshold no longer gives a wrong digit; a boxed 1 no longer reads as 4
- ocr: the name is the right line on a photo taken at an angle, survives a line OCR split in two, and keeps its accents
- ocr: a barcode too soft to decode is still located, so the form is read; uncertain digits are then left empty rather than guessed
- ocr: a large photo no longer fills only the IBAN on a phone low on memory
- app: a new version shows when the app is opened again, and an open app offers to update

## [2026-11-08]

### Added
- repo: MIT license and a link to the hosted app on GitHub Pages
- app: scan a poukaz na účet in the browser and build a payme link and a PAY by square QR
