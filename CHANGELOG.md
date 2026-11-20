# Changelog

## [2026-11-20]

### Fixed
- ocr: with two forms in the photo, the scan reads the one whose fields are in the frame, not the cut-off one whose barcode zxing found first
- ocr: a photo taken at an angle no longer reads the amount a box out (2,09 for 20,90); the box rows move onto the printed characters
- ocr: a stub of a box line left of the "=" no longer empties the amount, and a clean 0 that Tesseract skipped is read
- ocr: the message reads ľ, ť and ď, U and P, letters standing on a slanted rule, and a second row that runs past its boxes
- ocr: a barcode too blurred to decode is read from a sharpened crop of it, or from the digits printed under it, so a soft photo gets its IBAN
- ocr: a VS with a speck left of it, a capital Í, a Š read as "$" in the name and a box mark before the name no longer spoil those fields; a garbled message is left empty

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
