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
  const out: (string | null)[] = [];
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
    out.push(ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null);
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
export function segmentCells(img: Image, k: number): Tile[] {
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
  const limit = k * paper;

  const label = new Int32Array(n);
  const comps: { id: number; x0: number; y0: number; x1: number; y1: number; edge: boolean }[] = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (value[start] >= limit || label[start]) continue;
    const id = comps.length + 1;
    const c = { id, x0: w, y0: h, x1: 0, y1: 0, edge: false };
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const p = stack[--top];
      const y = Math.floor(p / w);
      const x = p - y * w;
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
      // label or of the next box (seen: three such pieces around VS 112613).
      return ch >= tallest * 0.7 && cw <= tallest * 1.5;
    })
    .sort((a, b) => a.x0 - b.x0)
    .map((c) => {
      const cw = c.x1 - c.x0 + 1;
      const ch = c.y1 - c.y0 + 1;
      const tw = cw + PAD * 2;
      const th = ch + PAD * 2;
      const out = new Uint8ClampedArray(tw * th * 4).fill(255);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          if (label[(c.y0 + y) * w + c.x0 + x] === c.id) {
            const o = ((PAD + y) * tw + PAD + x) * 4;
            out[o] = out[o + 1] = out[o + 2] = 0;
          }
        }
      }
      return { x: c.x0, width: tw, height: th, data: out, aspect: cw / ch, center: c.x0 + cw / 2, inkHeight: ch };
    });
}
