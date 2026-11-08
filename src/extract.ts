// Heuristic field extraction from OCR lines of a poukaz photo.
// This works on labels and patterns: find a label line, then read the value on
// the same line or on the nearest line below that overlaps it horizontally.
// Labels OCR missed are added first from the form template (layout.ts).

import { parseEuroWords } from "./amountwords";
import { isValidIban, normalizeIban } from "./iban";
import { fitLayout } from "./layout";
import { parseAmount } from "./payme";
import { strip } from "./text";

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  text: string;
  bbox: BBox;
  confidence: number;
  /** A label OCR missed, placed by the form template. */
  predicted?: boolean;
}

export interface Extracted {
  value: string;
  confidence: number;
  /** Area of the value (or of its label) in the OCR image, for a crop. */
  bbox?: BBox;
  /** Label line bbox, used to aim a second, digit-only pass. */
  labelBox?: BBox;
  /** Part of the value came from a list or the amount in words, not from these digits. */
  filled?: boolean;
  /** Found next to a label that the form template placed, not one OCR read. */
  predicted?: boolean;
}

export interface ExtractResult {
  iban?: Extracted;
  amount?: Extracted;
  vs?: Extracted;
  ss?: Extracted;
  ks?: Extracted;
  name?: Extracted;
  message?: Extracted;
  /** The euro part as printed in words. */
  amountWords?: { text: string; euros: number; confidence: number };
  /** The "EUR" and "cent" labels of the boxed amount, for the cell pass. */
  amountColumns?: { eur: BBox; cent: BBox };
  /** 48- or 50-digit runs, which may be the clear text under the barcode. */
  barcodeDigits: string[];
  /** The form template fit, when enough labels were read. */
  layout?: { anchors: number; residual: number; added: string[] };
}

/** Fix common OCR confusions inside a run that should be digits. */
export function fixDigits(s: string): string {
  return s
    .replace(/[Oo]/g, "0")
    .replace(/[Il|!]/g, "1")
    .replace(/[Ss]/g, "5")
    .replace(/[B]/g, "8")
    .replace(/[Z]/g, "2");
}

export function findIban(text: string): string | undefined {
  // Allow spaces, and OCR confusions in the digit part.
  const re = /S\s*K\s*([0-9OoIlSB]{2}(?:\s*[0-9OoIlSB]){20})/g;
  for (const m of text.matchAll(re)) {
    const cand = "SK" + fixDigits(m[1].replace(/\s/g, ""));
    if (isValidIban(cand)) return normalizeIban(cand);
  }
  return undefined;
}

const LABELS: Record<"vs" | "ss" | "ks" | "amount" | "name" | "message", RegExp> = {
  // OCR drops the first letter of the stub label: "ARIABILNY SYMBOL".
  vs: /ariabil/,
  ss: /specif/,
  // The form prints "KONŠT. SYMBOL".
  ks: /konst(?:an|\.|\s*symbol)/,
  amount: /suma\s*(cisl|cisi)|suma\b/,
  // Not plain "adresat": "Cislo uctu adresata" and "Sprava pre adresata" contain it too.
  name: /meno a priezvisko|nazov adresata|\(nazov\)|prijemca|^\s*adresat\s*:?\s*$/,
  message: /sprava pre/,
};

function overlapsX(a: BBox, b: BBox): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
}

/** Lines on the label's row, right after it: the left stub prints values there. */
function linesRightOf(lines: OcrLine[], label: OcrLine): OcrLine[] {
  const w = label.bbox.x1 - label.bbox.x0;
  const h = label.bbox.y1 - label.bbox.y0;
  const cy = (label.bbox.y0 + label.bbox.y1) / 2;
  return lines
    .filter(
      (l) =>
        l !== label &&
        l.bbox.x0 >= label.bbox.x1 &&
        l.bbox.x0 <= label.bbox.x1 + w * 0.75 &&
        Math.abs((l.bbox.y0 + l.bbox.y1) / 2 - cy) <= h * 0.8,
    )
    .sort((a, b) => a.bbox.x0 - b.bbox.x0);
}

function linesBelow(lines: OcrLine[], label: OcrLine, max = 2): OcrLine[] {
  const h = Math.max(1, label.bbox.y1 - label.bbox.y0);
  return lines
    .filter((l) => l !== label && l.bbox.y0 >= label.bbox.y0 + h * 0.5 && l.bbox.y0 <= label.bbox.y1 + h * 4)
    .filter((l) => overlapsX(l.bbox, label.bbox))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0)
    .slice(0, max);
}

/** Digits after the label text on the same line, ignoring box separators. */
function digitsAfterLabel(text: string, labelRe: RegExp, maxLen: number): string | undefined {
  const s = strip(text);
  const m = labelRe.exec(s);
  if (!m) return undefined;
  // strip() keeps digits and only drops accents, so cutting the stripped text is safe.
  return digitRun(s.slice(m.index + m[0].length), maxLen);
}

function tokensOf(s: string): string[] {
  return s.split(/[\s|[\]_:]+/).filter(Boolean);
}

/** A token with only digits or digit look-alikes, with a real digit or one look-alike. */
function isNumericToken(tok: string): boolean {
  return /^[0-9OoIlSB]+$/.test(tok) && (/\d/.test(tok) || tok.length === 1);
}

/**
 * First run of numeric-looking tokens, joined. Box separators split a boxed
 * number into one-digit tokens, so consecutive tokens are joined. The run must
 * hold at least one real digit: a lone look-alike is label or border noise.
 */
function digitRun(s: string, maxLen: number): string | undefined {
  let run = "";
  let real = false;
  for (const tok of tokensOf(s)) {
    if (isNumericToken(tok)) {
      run += fixDigits(tok);
      real ||= /\d/.test(tok);
    } else if (run) break;
  }
  if (!run || !real || run.length > maxLen) return undefined;
  return run;
}

/** A whole line that is a number. A boxed line that OCR garbled is not one. */
function wholeLineDigits(s: string, maxLen: number): string | undefined {
  return tokensOf(s).every(isNumericToken) ? digitRun(s, maxLen) : undefined;
}

function amountIn(s: string): string | undefined {
  const t = s.replace(/[|_]/g, " ");
  const eq = /=\s*([\d\s.]*\d)\s*[,.]\s*(\d{2})\b/.exec(t);
  if (eq) return eq[1].replace(/[\s.]/g, "") + "," + eq[2];
  const plain = /(?:^|\s)(\d{1,3}(?:[\s.]?\d{3})*|\d+)\s*[,.]\s*(\d{2})\s*(?:€|eur|EUR)?(?:\s|$)/.exec(t);
  if (plain) return plain[1].replace(/[\s.]/g, "") + "," + plain[2];
  return undefined;
}

/**
 * The form has no decimal separator: EUR and cent are two columns, and OCR
 * returns them as two lines on one row, as in "=28" and "50". The left part
 * must start with "=" or be under an "EUR" label, or any two numbers on a row
 * would match. Leftmost first, so the stub wins over the boxed copy.
 */
function splitColumnAmount(lines: OcrLine[]): Extracted | undefined {
  const sorted = [...lines].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  for (const left of sorted) {
    const m = /^=?\s*(\d[\d\s]*)$/.exec(left.text);
    if (!m) continue;
    const euros = m[1].replace(/\s/g, "");
    if (euros.length > 7) continue;
    const h = left.bbox.y1 - left.bbox.y0;
    const cy = (left.bbox.y0 + left.bbox.y1) / 2;
    const marked =
      left.text.startsWith("=") ||
      lines.some(
        (l) =>
          /\beur\b/.test(strip(l.text)) &&
          overlapsX(l.bbox, left.bbox) &&
          l.bbox.y1 <= left.bbox.y0 + h * 0.5 &&
          left.bbox.y0 - l.bbox.y1 <= h * 3,
      );
    if (!marked) continue;
    const right = sorted.find(
      (r) =>
        r !== left &&
        /^\d\s*\d$/.test(r.text) &&
        r.bbox.x0 >= left.bbox.x1 &&
        r.bbox.x0 <= left.bbox.x1 + h * 6 &&
        Math.abs((r.bbox.y0 + r.bbox.y1) / 2 - cy) <= h * 0.6,
    );
    if (!right) continue;
    const value = `${euros},${right.text.replace(/\s/g, "")}`;
    if (!parseAmount(value)) continue;
    return {
      value,
      confidence: Math.min(left.confidence, right.confidence),
      bbox: {
        x0: left.bbox.x0,
        y0: Math.min(left.bbox.y0, right.bbox.y0),
        x1: right.bbox.x1,
        y1: Math.max(left.bbox.y1, right.bbox.y1),
      },
    };
  }
  return undefined;
}

/** The amount in words is the only text the form wraps in "=". */
function findAmountWords(lines: OcrLine[]): ExtractResult["amountWords"] {
  for (const l of lines) {
    if (!/^=+[\p{L}\s]{3,}=*$/u.test(l.text)) continue;
    const euros = parseEuroWords(l.text);
    if (euros) return { text: l.text, euros, confidence: l.confidence };
  }
  return undefined;
}

/** The rightmost EUR and cent labels on one row: the boxed amount at the top of the form. */
function findAmountColumns(lines: OcrLine[]): ExtractResult["amountColumns"] {
  const row = (a: BBox, b: BBox) => Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) <= (a.y1 - a.y0) * 0.8;
  const eurs = lines.filter((l) => /^eur\W*$/.test(strip(l.text))).sort((a, b) => b.bbox.x0 - a.bbox.x0);
  for (const eur of eurs) {
    const w = eur.bbox.x1 - eur.bbox.x0;
    const cent = lines.find(
      (l) => /^cent\W*$/.test(strip(l.text)) && row(eur.bbox, l.bbox) && l.bbox.x0 > eur.bbox.x1 && l.bbox.x0 < eur.bbox.x1 + w * 4,
    );
    if (cent) return { eur: eur.bbox, cent: cent.bbox };
  }
  return undefined;
}

function isLabelText(s: string): boolean {
  const t = strip(s);
  return Object.values(LABELS).some((re) => re.test(t)) || /(ulica|psc|obec|odosielatel|cislo uctu|referen)/.test(t);
}

const MIN_MESSAGE_CONFIDENCE = 40;

export function extractFields(ocrLines: OcrLine[]): ExtractResult {
  const res: ExtractResult = { barcodeDigits: [] };
  const layout = fitLayout(ocrLines);
  // Added labels go last, so a label OCR read comes first wherever the order matters.
  const lines = layout ? [...ocrLines, ...layout.added] : ocrLines;
  if (layout) res.layout = { anchors: layout.anchors, residual: layout.residual, added: layout.added.map((l) => l.text) };
  const all = lines.map((l) => l.text).join("\n");

  const iban = findIban(all);
  if (iban) {
    const line = lines.find((l) => findIban(l.text) === iban);
    res.iban = { value: iban, confidence: line?.confidence ?? 50, bbox: line?.bbox };
  }

  for (const l of lines) {
    const compact = l.text.replace(/\s/g, "");
    for (const m of compact.matchAll(/\d{48,50}/g)) {
      if (m[0].length === 48 || m[0].length === 50) res.barcodeDigits.push(m[0]);
    }
  }

  const symbolMax = { vs: 10, ss: 10, ks: 4 } as const;
  for (const key of ["vs", "ss", "ks"] as const) {
    const re = LABELS[key];
    // The left stub repeats the field as plain text, and OCR reads that far
    // better than the boxed copy on the right. So the leftmost label goes first.
    const labels = lines.filter((l) => re.test(strip(l.text))).sort((a, b) => a.bbox.x0 - b.bbox.x0);
    if (!labels.length) continue;
    let found: Extracted | undefined;
    for (const label of labels) {
      let value = label.predicted ? undefined : digitsAfterLabel(label.text, re, symbolMax[key]);
      let box: BBox = label.bbox;
      // An added label has no confidence of its own: the value line gives it.
      let confidence = label.confidence;
      if (!value) {
        for (const right of linesRightOf(lines, label)) {
          if (isLabelText(right.text)) continue;
          value = wholeLineDigits(right.text, symbolMax[key]);
          if (value) {
            box = right.bbox;
            if (label.predicted) confidence = right.confidence;
            break;
          }
        }
      }
      if (!value) {
        for (const below of linesBelow(lines, label)) {
          // A value under a nearer label belongs to that label.
          if (isLabelText(below.text)) break;
          value = wholeLineDigits(below.text, symbolMax[key]);
          if (value) {
            box = below.bbox;
            if (label.predicted) confidence = below.confidence;
            break;
          }
        }
      }
      if (value) {
        found = { value, confidence, bbox: box, labelBox: label.bbox, predicted: label.predicted };
        break;
      }
    }
    // The cell pass reads the boxed copy, which is under the rightmost label.
    const boxed = labels[labels.length - 1];
    res[key] = found ?? { value: "", confidence: 0, labelBox: boxed.bbox, predicted: boxed.predicted };
  }

  // Amount: a line with "=" first, then a "Suma" label.
  const eqLine = lines.find((l) => /=\s*[\d\s.]*\d\s*[,.]\s*\d{2}/.test(l.text));
  if (eqLine) {
    const v = amountIn(eqLine.text);
    if (v && parseAmount(v)) res.amount = { value: v, confidence: eqLine.confidence, bbox: eqLine.bbox };
  }
  if (!res.amount) res.amount = splitColumnAmount(lines);
  if (!res.amount) {
    const label = lines.find((l) => LABELS.amount.test(strip(l.text)));
    if (label) {
      const cands = [label, ...linesBelow(lines, label)];
      for (const c of cands) {
        const v = amountIn(c.text);
        if (v && parseAmount(v)) {
          res.amount = { value: v, confidence: c.confidence, bbox: c.bbox, labelBox: label.bbox };
          break;
        }
      }
      if (!res.amount) res.amount = { value: "", confidence: 0, labelBox: label.bbox };
    }
  }

  res.amountWords = findAmountWords(lines);
  res.amountColumns = findAmountColumns(lines);

  for (const key of ["name", "message"] as const) {
    const label = lines.find((l) => LABELS[key].test(strip(l.text)));
    if (!label) continue;
    for (const below of linesBelow(lines, label, 3)) {
      if (isLabelText(below.text)) continue;
      const v = below.text.replace(/[|_[\]]/g, " ").replace(/\s+/g, " ").trim();
      if (/[A-Za-zÀ-ž]{3,}/.test(v)) {
        res[key] = { value: v, confidence: below.confidence, bbox: below.bbox, labelBox: label.bbox, predicted: label.predicted };
        break;
      }
    }
  }

  // The message is printed over its label, so the label is rarely read. The template knows the boxes.
  if (!res.message && layout) {
    const a = layout.messageArea;
    const inside = ocrLines
      .filter((l) => {
        const cx = (l.bbox.x0 + l.bbox.x1) / 2;
        const cy = (l.bbox.y0 + l.bbox.y1) / 2;
        return cx >= a.x0 && cx <= a.x1 && cy >= a.y0 && cy <= a.y1;
      })
      .sort((p, q) => p.bbox.y0 - q.bbox.y0);
    for (const l of inside) {
      // Box borders read as letters at low confidence ("THRRVN E" at 10); the real message read at 58.
      if (isLabelText(l.text) || l.confidence < MIN_MESSAGE_CONFIDENCE) continue;
      const v = l.text.replace(/[|_[\]]/g, " ").replace(/\s+/g, " ").trim();
      if (/[A-Za-zÀ-ž]{3,}/.test(v)) {
        res.message = { value: v, confidence: l.confidence, bbox: l.bbox, predicted: true };
        break;
      }
    }
  }

  return res;
}
