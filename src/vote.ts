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

/** Readings further than this from the middle one are of another line, and are left out.
 * A garbled full reading against two that stopped early was 0.4; other lines were 0.8 and more. */
const MAX_DISTANCE = 0.5;

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

/**
 * Edit operations from `a` to `b`: for each char of `a`, the char of `b` aligned to it ("" when
 * deleted), and the text `b` inserts before each position of `a` (index a.length: at the end).
 * Skipping the start or the end of `a` costs half a letter, so a reading that stopped early lines
 * up with the start of `a` instead of spreading its letters over all of it. Not free: a free
 * skip took "ZF " off the start rather than match its misread letters. `distance` includes
 * the skips at that half cost.
 */
function align(a: string, b: string): { sub: string[]; ins: string[]; distance: number; lead: number; trail: number } {
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) d[i][0] = i * SKIP;
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost(a[i - 1], b[j - 1]));
    }
  }
  let end = n;
  for (let i = 0; i <= n; i++) if (d[i][m] + (n - i) * SKIP < d[end][m]) end = i;
  const sub = new Array<string>(n).fill("");
  const ins = new Array<string>(n + 1).fill("");
  let i = end;
  let j = m;
  while (j > 0) {
    if (i > 0 && d[i][j] === d[i - 1][j - 1] + cost(a[i - 1], b[j - 1])) {
      sub[i - 1] = b[j - 1];
      i--;
      j--;
    } else if (i === 0 || d[i][j] === d[i][j - 1] + 1) {
      ins[i] = b[j - 1] + ins[i];
      j--;
    } else {
      i--;
    }
  }
  return { sub, ins, distance: d[end][m] + (n - end) * SKIP, lead: i, trail: n - end };
}

/** What skipping one letter at either end of the frame costs in `align`. */
const SKIP = 0.5;

/** A run of this many letters missing at either end is a reading that stopped early or
 * started late (a split line, a stub cut by the photo's edge): it does not vote there. */
const TRUNCATED = 3;

/** `b` aligned to `a`, with the places of `a` that `b` does not reach. */
function compare(a: string, b: string): { sub: string[]; ins: string[]; uncovered: boolean[]; distance: number } {
  const { sub, ins, distance, lead, trail } = align(a, b);
  const uncovered = new Array<boolean>(a.length).fill(false);
  // A short skip is a lost letter and counts against the reading; a long one is a reading
  // that did not get there.
  let extra = 0;
  if (lead >= TRUNCATED) {
    uncovered.fill(true, 0, lead);
    extra -= lead * SKIP;
  } else extra += lead * (1 - SKIP);
  if (trail >= TRUNCATED) {
    uncovered.fill(true, a.length - trail);
    extra -= trail * SKIP;
  } else extra += trail * (1 - SKIP);
  return { sub, ins, uncovered, distance: distance + extra };
}

/** Distance per letter over the part both readings cover. */
function normalized(a: string, b: string): number {
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  const c = compare(long, short);
  const covered = c.uncovered.filter((u) => !u).length;
  return c.distance / Math.max(1, covered, short.length);
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
function winner(votes: Map<string, number>, edge = false): string {
  // At either end of the line, a letter some readings have and others lack was cut off by
  // the photo's edge or the crop (a cut stub gave "POJENÁ"): the letter wins unless its
  // absence has more than twice its weight. Inside the line the plain majority decides.
  const none = votes.get("") ?? 0;
  const letters = [...votes].filter(([o]) => /[\p{L}\p{N}]/u.test(o)).sort((a, b) => b[1] - a[1]);
  if (edge && none > 0 && letters.length) {
    const total = letters.reduce((s, [, w]) => s + w, 0);
    if (total * 2 < none) return "";
    votes = new Map(letters);
  }
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

  // The middle reading is the frame, unless it stopped early: then the longest reading that
  // goes further, so a short reading cannot cut the result short.
  const further = used.filter((r) => r !== middle && compare(r.text, middle.text).uncovered.some(Boolean));
  const top = further.length ? further.reduce((a, b) => (b.text.length > a.text.length ? b : a)) : middle;
  const frame = top.text;
  const subVotes = Array.from({ length: frame.length }, () => new Map<string, number>());
  const insVotes = Array.from({ length: frame.length + 1 }, () => new Map<string, number>());
  const add = (m: Map<string, number>, option: string, w: number) => m.set(option, (m.get(option) ?? 0) + w);
  for (const r of used) {
    const w = weight(r.confidence);
    const { sub, ins, uncovered } =
      r === top
        ? { sub: [...frame], ins: new Array<string>(frame.length + 1).fill(""), uncovered: new Array<boolean>(frame.length).fill(false) }
        : compare(frame, r.text);
    sub.forEach((ch, i) => {
      if (!uncovered[i]) add(subVotes[i], ch, w);
    });
    // An insertion slot votes only between two places the reading reaches: where it was cut,
    // its last mark is often a piece of a letter ("VZOR!").
    ins.forEach((s, i) => {
      if (!uncovered[i - 1] && !uncovered[i]) add(insVotes[i], s, w);
    });
  }
  let text = "";
  for (let i = 0; i <= frame.length; i++) {
    text += winner(insVotes[i], i === 0 || i === frame.length);
    if (i < frame.length) text += winner(subVotes[i], i === 0 || i === frame.length - 1);
  }
  return { text: text.replace(/\s+/g, " ").trim(), used: used.length };
}
