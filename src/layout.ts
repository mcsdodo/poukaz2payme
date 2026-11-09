// Field template of the "Poštový poukaz na účet".
//
// The printed labels are at fixed places on the form. The labels OCR did read
// tell where the form is in the photo: an affine fit maps template points to
// photo points. The labels OCR missed are then added at their predicted place,
// so the label-relative extraction in extract.ts finds their values as usual.
//
// The template is the real form (product 38) after deskew, in pixels of that
// 2048 px wide photo. Two OCR runs of it agreed within 3 px. A label OCR read
// always wins over a predicted one: the template only fills gaps.

import type { BBox, OcrLine } from "./extract";
import { strip } from "./text";

interface Entry {
  box: BBox;
  /** Text of the label when it is added because OCR missed it. Entries without it only anchor the fit. */
  text?: string;
}

interface Group {
  re: RegExp;
  /** Left to right, as the form prints them. */
  entries: Entry[];
}

const b = (x0: number, y0: number, x1: number, y1: number): BBox => ({ x0, y0, x1, y1 });

const GROUPS: Group[] = [
  { re: /^podacie znaky/, entries: [{ box: b(654, 363, 802, 376) }] },
  { re: /^okr\.?\s*pec/, entries: [{ box: b(673, 406, 759, 422) }] },
  { re: /^podacie cislo/, entries: [{ box: b(77, 453, 222, 471) }] },
  { re: /^slovom$/, entries: [{ box: b(1181, 490, 1258, 505) }] },
  { re: /cislo uctu iban/, entries: [{ box: b(44, 775, 204, 794) }, { box: b(650, 567, 808, 584) }] },
  { re: /vyplatne v hotovosti/, entries: [{ box: b(52, 598, 282, 616) }] },
  { re: /vyplnajte zlava/, entries: [{ box: b(650, 597, 758, 615) }] },
  { re: /^v prvom riadku/, entries: [{ box: b(649, 617, 752, 632) }] },
  { re: /^kod sluzby/, entries: [{ box: b(296, 627, 418, 645) }] },
  { re: /^kod prod/, entries: [{ box: b(483, 633, 587, 650) }] },
  {
    re: /ariabil/,
    entries: [
      { box: b(40, 853, 234, 871), text: "VARIABILNÝ SYMBOL" },
      { box: b(1372, 628, 1556, 646), text: "VARIABILNÝ SYMBOL" },
    ],
  },
  { re: /konst(?:an|\.|\s*symbol)/, entries: [{ box: b(1820, 638, 1974, 656), text: "KONŠT. SYMBOL" }] },
  {
    re: /^adresat\W*$/,
    entries: [
      { box: b(37, 932, 125, 950), text: "ADRESÁT" },
      { box: b(649, 686, 736, 705), text: "ADRESÁT" },
    ],
  },
  { re: /^suma$/, entries: [{ box: b(46, 709, 98, 723), text: "SUMA" }] },
  { re: /^odosielatel\s*\(/, entries: [{ box: b(1344, 697, 1849, 722) }] },
  { re: /^meno$/, entries: [{ box: b(1234, 719, 1286, 735) }] },
  { re: /^priezvisko$/, entries: [{ box: b(1233, 786, 1341, 802) }] },
  {
    re: /specif/,
    entries: [
      { box: b(39, 891, 235, 909), text: "ŠPECIFICKÝ SYMBOL" },
      { box: b(664, 833, 857, 852), text: "ŠPECIFICKÝ SYMBOL" },
    ],
  },
  { re: /^ulica\/obec/, entries: [{ box: b(1233, 853, 1342, 869) }] },
  { re: /^cislo$/, entries: [{ box: b(1234, 986, 1286, 1004) }] },
  { re: /^psc$/, entries: [{ box: b(1782, 990, 1815, 1007) }] },
  { re: /davacia posta/, entries: [{ box: b(1234, 1054, 1401, 1073) }] },
  { re: /^odosielatel\W*$/, entries: [{ box: b(29, 1127, 159, 1143) }] },
  {
    re: /^eur\W*$/,
    entries: [
      { box: b(443, 715, 481, 729), text: "EUR" },
      { box: b(1438, 417, 1475, 431), text: "EUR" },
    ],
  },
  {
    re: /^cent\W*$/,
    entries: [
      { box: b(574, 719, 609, 732), text: "cent" },
      { box: b(1530, 422, 1562, 434), text: "cent" },
      // Under the amount in words. Anchors only.
      { box: b(1940, 512, 1969, 523) },
    ],
  },
];

/**
 * "SPRÁVA PRE ADRESÁTA" boxes. The message is printed over the label, so OCR
 * rarely reads the label, but it reads the message (on the real form "STRAVNÉ").
 */
const MESSAGE_AREA = b(640, 962, 1200, 1105);

/** A row of printed boxes, one character each: the first box's left edge, the pitch, the count. */
export interface Grid {
  x: number;
  pitch: number;
  n: number;
  y0: number;
  y1: number;
}

/**
 * Where the values are printed, in template pixels. Measured on two real photos
 * straightened by this fit (the box separators and the printed characters); the
 * two agreed within 6 px. Boxes are read from here instead of searched for next
 * to a label, so a field cannot pick up its neighbour's text.
 */
export const FIELDS = {
  /** VARIABILNÝ SYMBOL boxes, right column: 10 boxes, digits right-aligned. */
  vs: { x: 1357, pitch: 45.6, n: 10, y0: 652, y1: 704 } as Grid,
  /** KONŠT. SYMBOL: 4 boxes, right after the VS boxes. */
  ks: { x: 1809, pitch: 46.3, n: 4, y0: 652, y1: 704 } as Grid,
  /** ŠPECIFICKÝ SYMBOL, middle column: 10 boxes. */
  ss: { x: 641, pitch: 47.8, n: 10, y0: 855, y1: 908 } as Grid,
  /**
   * SUMA: 6 euro boxes (the "=" in the 4th, digits right-aligned) and 2 cent boxes, read as
   * one row; the separator between them is a little wider. Measured on both photos: digits at
   * x 1421, 1466 | 1516, 1561, y 457-482.
   */
  amount: { x: 1213, pitch: 46.4, n: 8, y0: 445, y1: 495 } as Grid,
  /**
   * The middle ADRESÁT block's first line: the payee's name. Its ink runs y 702-731 (accents
   * from 702), the second line starts at 733. OCR merged the two into one 85 px line, and a
   * re-read of that read nothing; this box is re-read on its own.
   */
  middleName: b(655, 699, 1175, 732),
  /** SPRÁVA PRE ADRESÁTA: two rows of 12 boxes. A word runs on from the first row to the second. */
  message: [
    { x: 662, pitch: 47.6, n: 12, y0: 1008, y1: 1066 },
    { x: 662, pitch: 47.6, n: 12, y0: 1078, y1: 1138 },
  ] as Grid[],
};

/** The boxes of a grid, each mapped into the photo. */
export function gridCells(layout: Layout, g: Grid): BBox[] {
  return Array.from({ length: g.n }, (_, i) => layout.map(b(g.x + i * g.pitch, g.y0, g.x + (i + 1) * g.pitch, g.y1)));
}

/** A matched label must sit this close to its predicted place, in template pixels (a label is about 18 tall). */
const TOLERANCE = 20;
const MIN_ANCHORS = 4;

interface Point {
  x: number;
  y: number;
}

/** x' = a x + b y + c, y' = d x + e y + f */
interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface Pair {
  t: Point;
  o: Point;
  entry: Entry;
  line: OcrLine;
}

export interface Layout {
  /** Template box to photo box. */
  map(box: BBox): BBox;
  /** Labels OCR missed, at their predicted place, marked `predicted`. */
  added: OcrLine[];
  /** Where the message is printed, in the photo. */
  messageArea: BBox;
  anchors: number;
  /** Largest anchor error after the fit, in template pixels. */
  residual: number;
}

// The left edge and the middle height of a label. OCR boxes end where the
// text ends, and a trailing speck often widens them, so the right edge is weaker.
const anchor = (box: BBox): Point => ({ x: box.x0, y: (box.y0 + box.y1) / 2 });

const apply = (m: Affine, p: Point): Point => ({ x: m.a * p.x + m.b * p.y + m.c, y: m.d * p.x + m.e * p.y + m.f });

const scaleOf = (m: Affine): number => Math.sqrt(Math.abs(m.a * m.e - m.b * m.d));

/** Solves a 3x3 system by Gaussian elimination, or undefined when it is singular. */
function solve3(m: number[][], r: number[]): number[] | undefined {
  const a = m.map((row, i) => [...row, r[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let i = col + 1; i < 3; i++) if (Math.abs(a[i][col]) > Math.abs(a[piv][col])) piv = i;
    if (Math.abs(a[piv][col]) < 1e-9) return undefined;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let i = 0; i < 3; i++) {
      if (i === col) continue;
      const k = a[i][col] / a[col][col];
      for (let j = col; j < 4; j++) a[i][j] -= k * a[col][j];
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
}

/** Least-squares affine map, or undefined when the points are on one line. */
function fitAffine(pairs: Pair[]): Affine | undefined {
  // Template points are around 1000 px: center them so the system stays well conditioned.
  const cx = pairs.reduce((s, p) => s + p.t.x, 0) / pairs.length;
  const cy = pairs.reduce((s, p) => s + p.t.y, 0) / pairs.length;
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rx = [0, 0, 0];
  const ry = [0, 0, 0];
  for (const p of pairs) {
    const v = [p.t.x - cx, p.t.y - cy, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) m[i][j] += v[i] * v[j];
      rx[i] += v[i] * p.o.x;
      ry[i] += v[i] * p.o.y;
    }
  }
  const sx = solve3(m, rx);
  const sy = solve3(m, ry);
  if (!sx || !sy) return undefined;
  const [a, b2, c0] = sx;
  const [d, e, f0] = sy;
  return { a, b: b2, c: c0 - a * cx - b2 * cy, d, e, f: f0 - d * cx - e * cy };
}

/** Close to a scaled rotation: a real form is not mirrored, squeezed or sheared. */
function isFormLike(m: Affine): boolean {
  // Column lengths are the scale along template x and y; their ratio is the squeeze.
  const sx = Math.hypot(m.a, m.d);
  const sy = Math.hypot(m.b, m.e);
  if (m.a <= 0 || m.e <= 0 || sx / sy > 1.25 || sy / sx > 1.25) return false;
  // Shear: the template axes must stay close to perpendicular.
  return Math.abs(m.a * m.b + m.d * m.e) / (sx * sy) <= 0.1;
}

/**
 * Drops the worst anchor until every anchor is within tolerance. Only the
 * final map must look like a form: one stray label can bend the first fit.
 */
function robustFit(start: Pair[]): { fit: Affine; pairs: Pair[]; residual: number } | undefined {
  let pairs = [...start];
  while (pairs.length >= MIN_ANCHORS) {
    const fit = fitAffine(pairs);
    if (!fit) return undefined;
    const s = Math.max(scaleOf(fit), 1e-3);
    const errs = pairs.map((p) => {
      const q = apply(fit, p.t);
      return Math.hypot(q.x - p.o.x, q.y - p.o.y) / s;
    });
    const worst = errs.indexOf(Math.max(...errs));
    if (errs[worst] <= TOLERANCE) return isFormLike(fit) ? { fit, pairs, residual: errs[worst] } : undefined;
    pairs = pairs.filter((_, i) => i !== worst);
  }
  return undefined;
}

/** The barcode's bars, measured on the straightened real photo. */
export const CODE_BOX = b(836, 1167, 1754, 1256);

/**
 * The template placed by the barcode alone, when OCR read too few labels to fit
 * it (a soft live shot: the values legible, the small labels a blur). The photo
 * is already level, so this is a scale and a shift. The code is at the bottom,
 * so the top of the form carries the code's error several times over: the grids
 * move to their characters anyway (gridTiles), and every label it adds is marked.
 */
export function layoutFromCode(code: BBox): Layout {
  const s = (code.x1 - code.x0) / (CODE_BOX.x1 - CODE_BOX.x0);
  const cy = (CODE_BOX.y0 + CODE_BOX.y1) / 2;
  const fit: Affine = { a: s, b: 0, c: code.x0 - CODE_BOX.x0 * s, d: 0, e: s, f: (code.y0 + code.y1) / 2 - cy * s };
  return makeLayout(fit, new Set(), 0, 0);
}

export function fitLayout(lines: OcrLine[]): Layout | undefined {
  const texts = lines.map((l) => strip(l.text));
  const candidates = GROUPS.map((g) => lines.filter((_, i) => g.re.test(texts[i])).sort((p, q) => p.bbox.x0 - q.bbox.x0));

  // Seeds: groups where OCR found exactly as many lines as the form prints, matched left to right.
  const seeds: Pair[] = [];
  GROUPS.forEach((g, gi) => {
    const c = candidates[gi];
    if (c.length !== g.entries.length) return;
    g.entries.forEach((entry, i) => seeds.push({ t: anchor(entry.box), o: anchor(c[i].bbox), entry, line: c[i] }));
  });
  const first = robustFit(seeds);
  if (!first) return undefined;

  // Then every other matching line, at the entry nearest to where the fit puts it.
  const pairs = [...first.pairs];
  const usedLines = new Set(pairs.map((p) => p.line));
  const usedEntries = new Set(pairs.map((p) => p.entry));
  const s = scaleOf(first.fit);
  GROUPS.forEach((g, gi) => {
    for (const line of candidates[gi]) {
      if (usedLines.has(line)) continue;
      let best: Entry | undefined;
      let bestErr = TOLERANCE;
      for (const entry of g.entries) {
        if (usedEntries.has(entry)) continue;
        const q = apply(first.fit, anchor(entry.box));
        const o = anchor(line.bbox);
        const err = Math.hypot(q.x - o.x, q.y - o.y) / s;
        if (err <= bestErr) {
          bestErr = err;
          best = entry;
        }
      }
      if (best) {
        pairs.push({ t: anchor(best.box), o: anchor(line.bbox), entry: best, line });
        usedLines.add(line);
        usedEntries.add(best);
      }
    }
  });
  const final = robustFit(pairs) ?? first;
  return makeLayout(final.fit, new Set(final.pairs.map((p) => p.entry)), final.pairs.length, Math.round(final.residual * 10) / 10);
}

function makeLayout(fit: Affine, matched: Set<Entry>, anchors: number, residual: number): Layout {
  // An entry whose OCR line the fit rejected stays unmatched, but that line is still in the
  // input. Adding a label next to it is harmless: the real line comes first in the input.
  const map = (box: BBox): BBox => {
    const ps = [
      { x: box.x0, y: box.y0 },
      { x: box.x1, y: box.y0 },
      { x: box.x1, y: box.y1 },
      { x: box.x0, y: box.y1 },
    ].map((p) => apply(fit, p));
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const added: OcrLine[] = [];
  for (const g of GROUPS) {
    for (const entry of g.entries) {
      if (entry.text && !matched.has(entry)) added.push({ text: entry.text, bbox: map(entry.box), confidence: 0, predicted: true });
    }
  }
  return { map, added, messageArea: map(MESSAGE_AREA), anchors, residual };
}
