// Evens out the lighting of a photo. A phone held over the form throws a soft
// shadow across it, and Tesseract binarizes the whole page at one threshold:
// on the real photo the shaded half went solid black, and OCR read almost
// nothing from it. Dividing each pixel by the local paper brightness makes the
// paper white everywhere and keeps the print, in its own color.

interface Image {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** The paper estimate is built on blocks this fraction of the longer side. */
const BLOCK_FRACTION = 1 / 200;
/** Max filter radius in blocks: must span the widest print (a bar group, a bold digit). */
const MAX_RADIUS = 3;
/** Box blur radius in blocks, so the block edges do not show. */
const BLUR_RADIUS = 3;

/**
 * Divides every channel by the local paper brightness, in place. The paper is
 * the brightest gray value near each pixel: a block maximum, widened by a max
 * filter so that a thick stroke does not count as paper, then smoothed.
 */
export function flattenLight(img: Image): void {
  const { data, width: w, height: h } = img;
  const block = Math.max(4, Math.round(Math.max(w, h) * BLOCK_FRACTION));
  const bw = Math.ceil(w / block);
  const bh = Math.ceil(h / block);

  // 1. Brightest gray per block.
  const blocks = new Float32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    const row = ((y / block) | 0) * bw;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const b = row + ((x / block) | 0);
      if (g > blocks[b]) blocks[b] = g;
    }
  }

  // 2. Max filter, then box blur, both separable.
  const paper = boxBlur(maxFilter(blocks, bw, bh, MAX_RADIUS), bw, bh, BLUR_RADIUS);

  // 3. Divide, sampling the block grid bilinearly at the pixel center.
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const top = paper[y0 * bw + x0] * (1 - tx) + paper[y0 * bw + x1] * tx;
      const bottom = paper[y1 * bw + x0] * (1 - tx) + paper[y1 * bw + x1] * tx;
      const scale = 255 / Math.max(16, top * (1 - ty) + bottom * ty);
      const i = (y * w + x) * 4;
      data[i] = data[i] * scale;
      data[i + 1] = data[i + 1] * scale;
      data[i + 2] = data[i + 2] * scale;
    }
  }
}

function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++, n++) s += src[y * w + k];
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++, n++) s += tmp[k * w + x];
      out[y * w + x] = s / n;
    }
  }
  return out;
}
