// Finds the poukaz barcode by its look when it cannot be decoded.
//
// A live shot of a form at arm's length came out soft: the bars ran into each
// other and no decoder read them, but the digits printed under them were sharp.
// Everything after the barcode (the quarter turn, the tilt, the form crop, the
// template fit) needs only where the code is, not what it says, and the IBAN
// can then come from those digits. A barcode is the one big area of the form
// with steep edges across and almost none down.

interface Image {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The code is about half the form wide and about 1/14 of its width tall. */
const MIN_ASPECT = 4;
/** Window of the edge average, as a fraction of the image width. */
const WINDOW = 1 / 80;

/**
 * The box of the barcode's bars, in the image's pixels, or undefined. Only a
 * code with horizontal rows of bars (the form level or upside down), as the
 * live view and most photos give it.
 */
export function locateBarcode(img: Image): Box | undefined {
  const { data, width: w, height: h } = img;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;

  // Edges across minus edges down: bars score high, text and form lines low.
  const score = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + w] - gray[i - w]);
      score[i] = gx - gy;
    }
  }

  // Average over a window with an integral image.
  const r = Math.max(2, Math.round(w * WINDOW));
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += score[y * w + x];
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
    }
  }
  const avg = new Float32Array(w * h);
  let max = 0;
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(w, x + r + 1);
      const s = sum[yb * (w + 1) + xb] - sum[ya * (w + 1) + xb] - sum[yb * (w + 1) + xa] + sum[ya * (w + 1) + xa];
      const v = s / ((yb - ya) * (xb - xa));
      avg[y * w + x] = v;
      if (v > max) max = v;
    }
  }
  if (max <= 0) return undefined;

  // The strongest region, then the widest one of the right shape.
  const limit = max * 0.45;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best: (Box & { area: number }) | undefined;
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || avg[start] < limit) continue;
    const b = { x0: w, y0: h, x1: 0, y1: 0, area: 0 };
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const p = stack[--top];
      const y = Math.floor(p / w);
      const x = p - y * w;
      b.area++;
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || seen[q] || avg[q] < limit) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        seen[q] = 1;
        stack[top++] = q;
      }
    }
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    // A solid band, wide and flat: a code. Text lines are flat too but score low.
    if (bw / bh >= MIN_ASPECT && b.area >= bw * bh * 0.5 && (!best || b.area > best.area)) best = b;
  }
  if (!best) return undefined;
  // At 0.45 of the peak the region's edge is where the window half covers the bars: the
  // bars' edge. On a sharp photo it matched zxing's ends within 3 px of 1000.
  return { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 };
}
