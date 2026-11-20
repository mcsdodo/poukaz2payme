# Testing

`npm test` runs the unit tests: barcode layouts, checksums, the payme link, PAY by square,
and the recognition rules on synthetic images and on OCR lines with fake data
(`test/fixtures/`). They need nothing outside this repository.

`npm run test:photos` runs **real photos** of filled-in forms through the built app in a
headless Chromium and compares every field with what the form prints. Recognition changes
are judged by it: a rule that helps one photo can break another.

## The photos live outside this repository

A filled-in poukaz is personal data: the payer's and often a child's name, the payee's
account, the payment symbols. So the photos are never committed here. They live in a
separate folder, which you can keep as your own **private** Git repository:

```
poukaz2payme/            this repository
poukaz2payme-photos/     next to it
  truth.json
  photos/
    01-kitchen-table.jpg
    ...
```

The script looks for `../poukaz2payme-photos`; set `POUKAZ_PHOTOS` to use another folder.
Without one it says so and exits without failing. The maintainer's set is a private
repository of that name.

### truth.json

One entry per photo (example with fake values:
[test/photos.example/truth.json](test/photos.example/truth.json)):

- `file`: the photo in `photos/`, exactly as the phone's camera app saved it. Do not
  resize, re-encode or strip EXIF: phones store the photo sideways with an orientation tag,
  and a copy resized without applying it reads nothing.
- `about`: what makes the photo hard (a second form, shadow, blur, an unusual font).
- `expect`: the fields as the form prints them. `iban` may have spaces, `amount` is `20,90`,
  an empty SS is `""`, `name` is the payee's first line without a trailing comma, `message`
  is both rows joined (`MŠ-Sliepky,MARTIN HUDEC`). Leave out a field you do not want checked.

## Running

```sh
npm run test:photos              # builds, then reads every photo
npm run test:photos -- glove 08  # only photos whose file name contains one of these
```

Chromium comes from Playwright. On your own machine run `npx playwright install chromium`
once; Claude Code cloud sessions already have it.

Each photo prints ✓, or its misses: a field `empty` or `wrong`, with the value read. The
summary counts right fields, and empty and wrong ones per field. **A wrong IBAN, amount, VS,
KS or SS fails the run** (exit code 1): that is a payment with the wrong data, and the app
must leave such a field empty instead. A wrong name or message, or an empty field, does
not fail it: the app flags those for the user to check. Each photo's diagnostics (the
result screen's "Diagnostika") are written to `test-results/photos/`, which git ignores.

## In Claude Code cloud sessions

Attach the photos repository to the session as well (it needs the Claude GitHub App's
access): repositories attached to a session are cloned side by side, so the script finds it
with no setup. To have it in every session, add it under Repositories in the cloud
environment's settings.

## Keeping the data out of this repository

- `.gitignore` covers `test-results/`, `/photos/` and `/poukaz2payme-photos/`, in case
  the folder is copied in here.
- Report results here (commits, issues, pull requests, CLAUDE.md) as counts and field
  names; quote a misread only as far as a rule needs it, never a whole form.
- A photo that reads badly can still become a unit test: copy its OCR lines from the
  diagnostics into `test/fixtures/` and replace every personal and payment value with a fake
  one of the same shape, as the existing fixtures do.
