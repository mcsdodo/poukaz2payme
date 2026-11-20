// Isolates the characters of a boxed field. The cells print one character each,
// and Tesseract is unstable on a whole boxed line but stable on one character.

export interface Tile {
  x: number;
  width: number;
  height: number;
  /** RGBA, black character on white. */
  data: Uint8ClampedArray;
  /** Width over height of the character itself, without the margin. */
  aspect: number;
  /** Middle of the character and its height, in crop pixels, to match it across thresholds. */
  center: number;
  inkHeight: number;
}

/** One threshold's reading: each character where it stands, null when unreadable. */
export interface CellReading {
  cells: { center: number; inkHeight: number; ch: string | null }[];
}

/**
 * Votes the characters of several threshold readings of one boxed field. A
 * threshold can change a shape: at 0.4 a printed 6 lost its loop and read as a
 * confident 5, while 0.5 read 6. Characters are matched by position. A place
 * fewer than half the readings saw is a speck one threshold made, but only when
 * two complete readings agree without it: a threshold also loses real digits
 * (0.5 read KS 017, 0.6 read 0179). A place's character is the one most readings
 * agree on; a tie between two different characters is unreadable, never a guess.
 */
export function voteCells(readings: CellReading[]): (string | null)[] {
  return voteCellsAt(readings).map((p) => p.ch);
}

/** voteCells with the place of each result: the middle of its characters' centers. */
export function voteCellsAt(readings: CellReading[]): { center: number; ch: string | null }[] {
  const all = readings.flatMap((r, i) => r.cells.map((c) => ({ ...c, reading: i })));
  if (!all.length) return [];
  const heights = all.map((c) => c.inkHeight).sort((a, b) => a - b);
  const tolerance = heights[heights.length >> 1] * 0.5;
  all.sort((a, b) => a.center - b.center);
  const places: (typeof all)[] = [];
  for (const c of all) {
    const last = places[places.length - 1];
    if (last && c.center - last[0].center <= tolerance) last.push(c);
    else places.push([c]);
  }
  const complete = readings.map((r) => r.cells.every((c) => c.ch !== null));
  const out: { center: number; ch: string | null }[] = [];
  for (const place of places) {
    const seen = new Set(place.map((c) => c.reading));
    if (seen.size * 2 < readings.length) {
      const without = readings.map((_, i) => i).filter((i) => !seen.has(i) && complete[i]);
      const agree = without.length >= 2 && without.every((i) => readings[i].cells.map((c) => c.ch).join("") === readings[without[0]].cells.map((c) => c.ch).join(""));
      if (agree || !place.some((c) => c.ch)) continue;
    }
    const counts = new Map<string, number>();
    for (const c of place) if (c.ch) counts.set(c.ch, (counts.get(c.ch) ?? 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1]);
    const center = place.reduce((sum, c) => sum + c.center, 0) / place.length;
    out.push({ center, ch: ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null });
  }
  return out;
}

interface Image {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

// White margin around a character. At 14 px Tesseract returned nothing for a
// clean 9 in every page mode; at 44 px it read it with confidence 95.
const PAD = 44;

/**
 * Splits a crop into one tile per printed character, left to right.
 *
 * `k` sets the ink threshold as a fraction of the paper brightness. Shapes that
 * touch the crop edge are dropped: those are the table next to the form, or
 * label text cut by the crop. Shapes much smaller than the tallest one are
 * specks.
 */
interface Component {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  edge: boolean;
  /** Ink pixels. */
  area: number;
}

/**
 * Connected dark shapes. `k` sets the ink threshold as a fraction of the paper
 * brightness, and brightness is the brightest channel, so the green form print
 * and the pink box fill count as paper and only black print is ink.
 */
function components(
  img: Image,
  k: number,
  rules?: { across: number; down: number },
  band?: { y0: number; y1: number },
): { comps: Component[]; label: Int32Array } {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const value = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const v = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    value[i] = v;
    hist[v]++;
  }
  let paper = 0;
  for (let acc = 0; paper < 255 && (acc += hist[paper]) < n * 0.75; paper++);
  let limit = k * paper;
  if (rules) {
    // A soft photo prints grey, not black: its darkest strokes stayed above half the paper
    // and every box read as empty. With real contrast in the crop but no ink below the
    // limit, the limit moves to halfway between the darkest ink and the paper.
    let dark = 0;
    for (let acc = 0; dark < 255 && (acc += hist[dark]) < n * 0.01; dark++);
    if (dark >= limit * 0.9 && paper - dark > paper * 0.2) limit = Math.max(limit, (dark + paper) / 2 - (0.5 - k) * paper * 0.5);
    eraseRules(value, w, h, limit, rules);
  }
  // Outside the row's band is the next row or a rule; cut it off so that a letter printed
  // over a slanted rule (the H at the column's border) keeps only the rule's short piece.
  if (band) {
    for (let y = 0; y < h; y++) if (y < band.y0 || y > band.y1) value.fill(255, y * w, (y + 1) * w);
  }

  const label = new Int32Array(n);
  const comps: Component[] = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (value[start] >= limit || label[start]) continue;
    const id = comps.length + 1;
    const c = { id, x0: w, y0: h, x1: 0, y1: 0, edge: false, area: 0 };
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const p = stack[--top];
      const y = Math.floor(p / w);
      const x = p - y * w;
      c.area++;
      c.x0 = Math.min(c.x0, x);
      c.x1 = Math.max(c.x1, x);
      c.y0 = Math.min(c.y0, y);
      c.y1 = Math.max(c.y1, y);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.edge = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (value[q] < limit && !label[q]) {
            label[q] = id;
            stack[top++] = q;
          }
        }
      }
    }
    comps.push(c);
  }
  return { comps, label };
}

/**
 * Erases the form's rules: ink runs longer than any letter stroke, `across` px
 * along a row or `down` px down a column. A letter touching a rule merged with
 * it and was dropped as a line (the H at the column's border, A and R on the
 * rule under the message). Colour does not tell them apart: after the light is
 * evened out the rule was as grey as the print on one photo.
 */
function eraseRules(value: Uint8Array, w: number, h: number, limit: number, rules: { across: number; down: number }): void {
  const ink = (x: number, y: number) => value[y * w + x] < limit;
  // A rule on a photo is a little slanted and its print is uneven: it steps a pixel up or
  // down every so often and has pale gaps, so along one pixel row it breaks into pieces
  // shorter than the limit, and the pieces left on the letters standing on it read as part
  // of them (B with a tail, U and R underlined). So a run follows the ink one pixel up or
  // down, and a gap of up to GAP pixels does not end it.
  const GAP = 2;
  const erase: number[] = [];
  // In a run, the pieces of the row's own ink at least half the limit long: the rule's steps.
  // The bottom of a letter standing on the rule is in the run (the rule is a pixel below it)
  // but short, and stays: erased, a B's foot went and it read R.
  const eraseRun = (x0: number, x1: number, y: number) => {
    let a = -1;
    let b = -1;
    for (let x = x0; x <= x1 + GAP + 1; x++) {
      if (x <= x1 && ink(x, y)) {
        if (a < 0) a = x;
        b = x;
      } else if (a >= 0 && (x - b > GAP || x > x1)) {
        if (b - a + 1 >= rules.across * 0.5) for (let i = a; i <= b; i++) if (ink(i, y)) erase.push(y * w + i);
        a = -1;
      }
    }
  };
  for (let y = 0; y < h; y++) {
    let start = -1;
    let last = -1;
    for (let x = 0; x <= w; x++) {
      const near = x < w && (ink(x, y) || (y > 0 && ink(x, y - 1)) || (y < h - 1 && ink(x, y + 1)));
      if (near) {
        if (start < 0) start = x;
        last = x;
      } else if (start >= 0 && (x - last > GAP || x === w)) {
        if (last - start + 1 >= rules.across) eraseRun(start, last, y);
        start = -1;
      }
    }
  }
  // Down a column the runs stay strict: tolerant, a faint box separator joined the stem of a
  // B or a P standing next to it and took the stem with it, and the column's border split a K.
  for (let x = 0; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && ink(x, y);
      if (on && start < 0) start = y;
      if (!on && start >= 0) {
        if (y - start >= rules.down) for (let i = start; i < y; i++) erase.push(i * w + x);
        start = -1;
      }
    }
  }
  for (const i of erase) value[i] = 255;
}

/** A tile of the given shapes, black on white with the margin Tesseract needs. */
function tileOf(label: Int32Array, w: number, parts: Component[]): Tile {
  const x0 = Math.min(...parts.map((c) => c.x0));
  const y0 = Math.min(...parts.map((c) => c.y0));
  const x1 = Math.max(...parts.map((c) => c.x1));
  const y1 = Math.max(...parts.map((c) => c.y1));
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const ids = new Set(parts.map((c) => c.id));
  const tw = cw + PAD * 2;
  const th = ch + PAD * 2;
  const out = new Uint8ClampedArray(tw * th * 4).fill(255);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (ids.has(label[(y0 + y) * w + x0 + x])) {
        const o = ((PAD + y) * tw + PAD + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = 0;
      }
    }
  }
  return { x: x0, width: tw, height: th, data: out, aspect: cw / ch, center: x0 + cw / 2, inkHeight: ch };
}

export function segmentCells(img: Image, k: number): Tile[] {
  const { width: w, height: h } = img;
  const { comps, label } = components(img, k);

  // A tall thin shape is a piece of a form line. It must not set the height scale.
  const inner = comps.filter((c) => !c.edge && c.x1 - c.x0 + 1 >= (c.y1 - c.y0 + 1) * 0.12);
  if (!inner.length) return [];
  const tallest = Math.max(...inner.map((c) => c.y1 - c.y0 + 1));
  // A digit fills about 0.37 of the crop height, so a lone shape under half of
  // that is a speck in an empty field, not a character.
  if (tallest < h * 0.18) return [];
  return inner
    .filter((c) => {
      const cw = c.x1 - c.x0 + 1;
      const ch = c.y1 - c.y0 + 1;
      // Digits print at one height. A shape about half as tall is a piece of the
      // label or of the next box (seen: three such pieces around a VS).
      return ch >= tallest * 0.7 && cw <= tallest * 1.5;
    })
    .sort((a, b) => a.x0 - b.x0)
    .map((c) => tileOf(label, w, [c]));
}

export interface GridTile extends Tile {
  /** Height of the tallest shape in the box: the letter without its accent, for upper or lower case. */
  mainHeight: number;
  /** Width of that shape: a bare vertical bar is l or I. */
  mainWidth: number;
  /** Separate marks above the letter: an accent or a caron (1), the dots of ä (2). */
  marks: number;
  /** Shapes in the box: a bare bar is one. */
  parts: number;
  /** Middle of the ink, from the crop's top: punctuation sits low ("," ".") or in the middle ("-"). */
  middle: number;
  /** A small upright mark beside the letter's top, left out of the tile: the caron of ľ, ť, ď. */
  apostrophe: boolean;
}

/**
 * Cuts a thin vertical tail off the top and the bottom of a shape: a piece of a
 * rule the letter touches. The column's border is printed in the form's green,
 * pale enough that it breaks into runs too short to erase as a rule, and where
 * it crosses an O the two read as one shape 82 px tall in a row of 47 px
 * capitals: an O with an accent. Only a tail at least a tenth of a box long
 * goes, so a caron touching its letter (Š) stays, and only when a letter's
 * height is left.
 */
function trimTails(c: Component, label: Int32Array, w: number, cellH: number, typical: number): void {
  const thin = Math.max(3, cellH * 0.06);
  const inkIn = (y: number) => {
    let n = 0;
    for (let x = c.x0; x <= c.x1; x++) if (label[y * w + x] === c.id) n++;
    return n;
  };
  const clear = (y: number) => {
    for (let x = c.x0; x <= c.x1; x++) {
      if (label[y * w + x] === c.id) {
        label[y * w + x] = 0;
        c.area--;
      }
    }
  };
  let top = c.y0;
  while (top < c.y1 && inkIn(top) <= thin) top++;
  let bottom = c.y1;
  while (bottom > top && inkIn(bottom) <= thin) bottom--;
  // What is left must still be a letter: a K the border ran through is thin all the way down.
  if (bottom - top + 1 < typical * 0.8) return;
  if (top - c.y0 >= cellH * 0.1) {
    for (let y = c.y0; y < top; y++) clear(y);
    c.y0 = top;
  }
  if (c.y1 - bottom >= cellH * 0.1) {
    for (let y = bottom + 1; y <= c.y1; y++) clear(y);
    c.y1 = bottom;
  }
}

/**
 * A small upright mark just right of a tall letter's top half: the caron that
 * ľ, ť and ď print as an apostrophe ("Motýľ"). It stands beside the letter, not
 * above it, so it is no accent, and it was dropped as a speck.
 */
function isApostrophe(c: Component, l: Component, pitch: number): boolean {
  const cw = c.x1 - c.x0 + 1;
  const ch = c.y1 - c.y0 + 1;
  const lh = l.y1 - l.y0 + 1;
  return (
    c !== l &&
    ch >= cw &&
    ch >= 4 &&
    ch <= lh * 0.45 &&
    c.x0 >= l.x1 - 2 &&
    c.x0 <= l.x1 + pitch * 0.3 &&
    c.y0 >= l.y0 - lh * 0.15 &&
    c.y1 <= l.y0 + lh * 0.5
  );
}

/**
 * How far the printed characters sit below the row's band (negative: above), in
 * crop pixels. The template fit can be off by a third of a box up or down on a
 * photo taken at an angle: the amount's band then took in the SLOVOM label under
 * it, whose letters outnumbered the digits and moved the grid a box sideways
 * (2,09 for 20,90), and the KS digits printed high were cut at the band's top.
 * The row is where the large shapes are: box characters print at about half the
 * box height, labels at a quarter, so the middle is weighed by ink. Only shapes
 * within half a box of the band count, so an empty grid does not move onto the
 * next row's digits (the reference number under SS). Small moves are left alone.
 */
function rowShift(
  img: Image,
  k: number,
  rules: { across: number; down: number },
  cells: { x0: number; y0: number; x1: number; y1: number }[],
  cellH: number,
  pitch: number,
): number {
  const top = Math.min(...cells.map((c) => c.y0));
  const bottom = Math.max(...cells.map((c) => c.y1));
  const center = (top + bottom) / 2;
  const left = cells[0].x0 - pitch;
  const right = cells[cells.length - 1].x1 + pitch;
  const { comps } = components(img, k, rules);
  const big = comps
    .filter((c) => {
      const cw = c.x1 - c.x0 + 1;
      const ch = c.y1 - c.y0 + 1;
      const mx = (c.x0 + c.x1) / 2;
      const my = (c.y0 + c.y1) / 2;
      return !c.edge && ch >= cellH * 0.33 && ch <= cellH * 1.1 && cw >= 3 && cw <= pitch * 1.5 && mx >= left && mx <= right && Math.abs(my - center) <= cellH * 0.5;
    })
    .map((c) => ({ y: (c.y0 + c.y1) / 2, weight: c.area }))
    .sort((a, b) => a.y - b.y);
  const total = big.reduce((s, c) => s + c.weight, 0);
  if (!total) return 0;
  let acc = 0;
  const mid = big.find((c) => (acc += c.weight) >= total / 2)!.y;
  const dy = mid - center;
  return Math.abs(dy) >= cellH * 0.1 ? Math.max(-cellH * 0.4, Math.min(cellH * 0.4, dy)) : 0;
}

/**
 * The characters of a row of printed boxes, one per box, null for an empty box.
 * `cells` are the boxes in crop pixels, as the template fit puts them. That fit
 * is off by up to a quarter of a box, so the grid is first moved to where the
 * printed characters are: by the median distance of the letters from the box
 * middles. All the shapes whose middle falls in a box belong to it, so an
 * accent or a caron stays with its letter (Š, é). Shapes outside the grid are
 * the next field (KS's first 0 next to the VS boxes), and are not read.
 */
export function gridTiles(
  img: Image,
  cells: { x0: number; y0: number; x1: number; y1: number }[],
  k: number,
  /** The placement an earlier threshold chose: readings at several thresholds must stay box-aligned. */
  placed?: number,
  /**
   * Keep accents and punctuation with the letters (the message). Digits have none: a speck
   * at the foot of a 0 counted as its full stop, and "0." read as nothing.
   */
  marks = true,
): { tiles: (GridTile | null)[]; offset: number } {
  if (!cells.length) return { tiles: [], offset: 0 };
  const { width: w } = img;
  const pitch = (cells[cells.length - 1].x1 - cells[0].x0) / cells.length;
  // One box's height: the row's whole band is taller when the photo is a little tilted.
  const cellH = cells.map((c) => c.y1 - c.y0).sort((a, b) => a - b)[cells.length >> 1];
  // A letter stroke is under 0.6 of a box tall and well under a box wide; the rules run on.
  const rules = { across: pitch * 1.2, down: cellH * 0.9 };
  const dy = rowShift(img, k, rules, cells, cellH, pitch);
  const top = Math.min(...cells.map((c) => c.y0)) + dy;
  const bottom = Math.max(...cells.map((c) => c.y1)) + dy;
  const { comps, label } = components(img, k, rules, { y0: Math.floor(top), y1: Math.ceil(bottom) });
  const mid = (c: Component) => ({ x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 });
  const size = (c: Component) => ({ w: c.x1 - c.x0 + 1, h: c.y1 - c.y0 + 1 });
  // Slivers an erased rule leaves are 1-2 px thin; the rest must sit in the row, and form
  // lines running through are taller than a box or wider than two.
  const candidates = comps.filter((c) => {
    const { w: cw, h: ch } = size(c);
    const m = mid(c);
    // A thin bar nearly a box tall is a piece of a rule cut to the row (a letter is at most 0.6).
    const rule = cw <= cellH * 0.12 && ch >= cellH * 0.85;
    return !c.edge && !rule && cw >= 3 && ch >= 3 && ch <= cellH * 1.2 && cw <= pitch * 2 && m.y >= top && m.y <= bottom;
  });
  // Lowercase letters (a, e) are 0.3 of the box tall.
  const tallish = candidates.filter((c) => size(c).h >= cellH * 0.22 && c.area >= cellH * 0.3);
  // A thin bar much taller than the row's letters is a piece of a broken rule (66-83 px
  // against 50 px capitals), not an l or an I.
  const heights = tallish.map((c) => size(c).h).sort((a, b) => a - b);
  const typical = heights.length ? heights[heights.length >> 1] : cellH;
  for (const c of tallish) if (size(c).h > typical * 1.3 && size(c).w > cellH * 0.12) trimTails(c, label, w, cellH, typical);
  // A letter is at least 0.6 of the row's usual height (lowercase a: 36 px against 47 px);
  // half a letter (8x27 in an empty box) is a fragment.
  const inRow = tallish.filter((c) => size(c).h >= typical * 0.6 && !(size(c).w <= cellH * 0.12 && size(c).h > typical * 1.3));
  // A shape that starts below the middle of the row's letters is the label under the row (the
  // Č of ČÍTACIA ZÓNA under a message printed low), not a letter of it.
  const lineFoot = inRow.length ? inRow.map((c) => c.y1).sort((a, b) => a - b)[inRow.length >> 1] : bottom;
  const letters = inRow.filter((c) => c.y0 < lineFoot - typical * 0.4);
  // Small marks count only where print puts them: a hyphen is a flat dash (0.13 of the box
  // height wide, 3-4 px tall); an accent or a caron sits just above a letter (7x8 px for é);
  // a comma or a full stop at the letters' foot. Dust anywhere else is not read.
  const feet = letters.map((c) => c.y1).sort((a, b) => a - b);
  const foot = feet.length ? feet[feet.length >> 1] : bottom;
  // Punctuation follows a letter (a comma, a full stop) or stands between letters (a hyphen):
  // a mark with no letter within a box and a half is a speck or a stub of a box separator.
  const besideLetter = (c: Component) => letters.some((l) => Math.abs(mid(l).x - mid(c).x) <= pitch * 1.5);
  const shapes = candidates.filter((c) => {
    if (letters.includes(c)) return true;
    if (!marks) return false;
    if (tallish.includes(c)) return false;
    const { w: cw, h: ch } = size(c);
    // A hyphen sits at mid-letter height; a flat scrap of a rule at the letters' foot was read
    // as one ("MARTIN-HUDEC" for an empty box).
    const dashHeight = mid(c).y <= foot - typical * 0.2 && mid(c).y >= foot - typical * 0.75;
    if (cw >= cellH * 0.1 && cw >= ch * 2 && c.area >= cellH * 0.3) return besideLetter(c) && dashHeight;
    if (c.area < 8) return false;
    const accent = letters.some((l) => {
      const lw = l.x1 - l.x0;
      return c.y1 <= l.y0 + 3 && c.y1 >= l.y0 - cellH * 0.3 && mid(c).x >= l.x0 - lw * 0.3 && mid(c).x <= l.x1 + lw * 0.3;
    });
    // A comma or a full stop follows its letter in the next box (a speck two boxes after
    // the row's last letter read as a trailing comma).
    const follows = letters.some((l) => mid(c).x > mid(l).x && mid(c).x - mid(l).x <= pitch * 1.2);
    const stop = ch >= 4 && c.y1 >= foot - cellH * 0.05 && c.y1 <= foot + cellH * 0.15 && follows;
    return accent || stop || letters.some((l) => isApostrophe(c, l, pitch));
  });
  const centerOf = (i: number) => (cells[i].x0 + cells[i].x1) / 2;
  const nearest = (x: number) => Math.round((x - centerOf(0)) / pitch);
  const offsets = letters
    .map((c) => mid(c).x - centerOf(Math.min(cells.length - 1, Math.max(0, nearest(mid(c).x)))))
    .sort((a, b) => a - b);
  const median = offsets.length ? offsets[offsets.length >> 1] : 0;
  // The nudge picks the nearest box, so a fit off by about half a box can land one box out:
  // on a portrait photo the VS/KS grid sat a box left, VS lost its last digit and KS read the
  // VS's 3. The placement that leaves the fewest letters outside the grid wins; on a tie the
  // nudge stands. The crop reaches 1.6 boxes past the grid, so such letters are seen.
  // Only character-shaped ink counts: the bracket strokes at the row's ends (the KS's ┐)
  // are thinner and taller than any digit, and once pulled the grid a box the wrong way.
  const charLike = letters.filter((c) => size(c).w >= size(c).h * 0.2 && size(c).h <= typical * 1.25);
  // A grid one box out leaves its stray character within a box of its end; ink further out
  // is the next field (K. SPRAC.'s 3 stands 1.4 boxes right of the amount's cent boxes).
  const outside = (o: number) => charLike.filter((c) => {
    const i = nearest(mid(c).x - o);
    return i === -1 || i === cells.length;
  }).length;
  let offset = median;
  for (const o of [median - pitch, median + pitch]) if (outside(o) < outside(offset)) offset = o;
  if (placed !== undefined) offset = placed;
  const boxes: Component[][] = cells.map(() => []);
  for (const c of shapes) {
    const i = nearest(mid(c).x - offset);
    if (i >= 0 && i < cells.length) boxes[i].push(c);
  }
  const tiles = boxes.map((all) => {
    if (!all.length) return null;
    const tallest = all.reduce((a, b) => (b.y1 - b.y0 > a.y1 - a.y0 ? b : a));
    // The caron of ľ, ť, ď prints as an apostrophe beside the letter. It is left out of the
    // tile (Tesseract read l' as nothing) and added after.
    const apostrophe = all.some((c) => c !== tallest && isApostrophe(c, tallest, pitch));
    const parts = all.filter((c) => c === tallest || !isApostrophe(c, tallest, pitch));
    const t = tileOf(label, w, parts);
    const main = tallest;
    const y0 = Math.min(...parts.map((c) => c.y0));
    const y1 = Math.max(...parts.map((c) => c.y1));
    const marks = parts.filter((c) => c !== main && c.y1 <= main.y0 + 3).length;
    return { ...t, mainHeight: main.y1 - main.y0 + 1, mainWidth: main.x1 - main.x0 + 1, marks, parts: parts.length, middle: (y0 + y1) / 2, apostrophe };
  });
  return { tiles, offset };
}