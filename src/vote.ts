// Character vote over several readings of one printed line.
//
// The payee's address is printed twice on the form (the stub on the left and
// the ADRESÁT block in the middle), and each copy can be read twice: by the
// page OCR and again from its own crop. Every reading has different mistakes:
// on one photo the stub gave "SF OJENÁ ŠKOLA" and the middle copy "ŠSPOJENÁ
// ŠKOLA". Aligned letter by letter, the majority at each place is right more
// often than any single reading.

import { strip } from "./text";

export interface Reading {
  text: string;
  /** Tesseract's 0-100 confidence: the weight of the reading's vote. */
  confidence: number;
}

export interface Consensus {
  text: string;
  /** How many readings took part: the ones close enough to the others. */
  used: number;
}

/** Readings further than this from the middle one are of another line, and are left out. */
const MAX_DISTANCE = 0.4;

/**
 * Same letter up to case or accent: a near miss, cheaper than a different
 * letter. A letter for a space costs more than an insertion: OCR splits words
 * ("SF OJENÁ" for "SPOJENÁ"), and the space must be a gap, not take the letter's place.
 */
function cost(a: string, b: string): number {
  if (a === b) return 0;
  if ((a === " ") !== (b === " ")) return 1.5;
  if (strip(a) === strip(b)) return 0.3;
  return 1;
}

/** Edit operations from `a` to `b`: for each char of `a`, the char of `b` aligned to it ("" when
 * deleted), and the text `b` inserts before each position of `a` (index a.length: at the end). */
function align(a: string, b: string): { sub: string[]; ins: string[]; distance: number } {
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) d[i][0] = i;
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost(a[i - 1], b[j - 1]));
    }
  }
  const sub = new Array<string>(n).fill("");
  const ins = new Array<string>(n + 1).fill("");
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + cost(a[i - 1], b[j - 1])) {
      sub[i - 1] = b[j - 1];
      i--;
      j--;
    } else if (j > 0 && (i === 0 || d[i][j] === d[i][j - 1] + 1)) {
      ins[i] = b[j - 1] + ins[i];
      j--;
    } else {
      i--;
    }
  }
  return { sub, ins, distance: d[n][m] };
}

function normalized(a: string, b: string): number {
  return align(a, b).distance / Math.max(1, a.length, b.length);
}

/** Marks OCR adds around printed text: box borders, quotes for specks. They carry no letter. */
const JUNK = /[|[\]{}_"“”„«»~]/g;

function hasAccent(s: string): boolean {
  return /[\u0300-\u036f]/.test(s.normalize("NFD"));
}

/** A reading at confidence 0 still says something; one at 20 counts a fifth of one at 100. */
function weight(confidence: number): number {
  return Math.max(0.2, confidence / 100);
}

/**
 * The option with the most weight, in two steps: first the letter without its
 * accent, then the form of it. OCR drops accents far more often than it adds
 * them ("SKOLA" for "ŠKOLA"), so an accented form wins unless the plain one has
 * more than twice its weight.
 */
function winner(votes: Map<string, number>): string {
  const bases = new Map<string, number>();
  for (const [option, w] of votes) bases.set(strip(option), (bases.get(strip(option)) ?? 0) + w);
  let base = "";
  let top = -1;
  for (const [b, w] of bases) {
    if (w > top) {
      base = b;
      top = w;
    }
  }
  const forms = [...votes].filter(([option]) => strip(option) === base).sort((a, b) => b[1] - a[1]);
  const plain = forms.find(([option]) => !hasAccent(option));
  const accented = forms.find(([option]) => hasAccent(option));
  if (accented && (!plain || accented[1] * 2 >= plain[1])) return accented[0];
  return plain ? plain[0] : forms[0][0];
}

/**
 * The majority text of several readings of one line. The middle reading (the
 * one closest to all others) is the frame: every other reading is aligned to
 * it, and each of its letters, and each gap between them, takes the most
 * common choice, each reading weighted by its confidence.
 */
export function consensus(readings: Reading[]): Consensus | undefined {
  const rs = readings.map((r) => ({ ...r, text: r.text.replace(JUNK, " ").replace(/\s+/g, " ").trim() })).filter((r) => r.text);
  if (!rs.length) return undefined;
  const middle = rs
    .map((r) => ({ r, total: rs.reduce((s, o) => s + normalized(r.text, o.text), 0) }))
    .sort((a, b) => a.total - b.total || b.r.confidence - a.r.confidence)[0].r;
  const used = rs.filter((r) => r === middle || normalized(middle.text, r.text) <= MAX_DISTANCE);
  if (used.length < 2) return { text: middle.text, used: 1 };

  const frame = middle.text;
  const subVotes = Array.from({ length: frame.length }, () => new Map<string, number>());
  const insVotes = Array.from({ length: frame.length + 1 }, () => new Map<string, number>());
  const add = (m: Map<string, number>, option: string, w: number) => m.set(option, (m.get(option) ?? 0) + w);
  for (const r of used) {
    const w = weight(r.confidence);
    const { sub, ins } = r === middle ? { sub: [...frame], ins: new Array<string>(frame.length + 1).fill("") } : align(frame, r.text);
    sub.forEach((ch, i) => add(subVotes[i], ch, w));
    ins.forEach((s, i) => add(insVotes[i], s, w));
  }
  let text = "";
  for (let i = 0; i <= frame.length; i++) {
    text += winner(insVotes[i]);
    if (i < frame.length) text += winner(subVotes[i]);
  }
  return { text: text.replace(/\s+/g, " ").trim(), used: used.length };
}
