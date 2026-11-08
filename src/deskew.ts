// Measures the small tilt of a photo from the reading zone of the poukaz.
//
// The corners zxing reports for a 1D code are two horizontal scan lines, so
// their top edge is level even when the form is tilted, and a 2 degree turn
// moves the side edges by 1 or 2 px. The bars are no better: a photo taken at a
// slight angle shears the paper, and on the real form the bars leaned half a
// degree away from the text rows. So this measures the rows. The bar tops, the
// bar bottoms, the digits under the bars and the zone caption all run along the
// rows for the whole width of the code, and summing the zone along the right
// angle gives the sharpest row profile. zxing stops reading a Code 128 around 4
// degrees, so the search range below is wide enough.

export interface Point {
  x: number;
  y: number;
}

interface Image {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const MAX_DEG = 8;

/**
 * Angle in degrees by which the rows of the form are turned clockwise (y down),
 * or undefined when the zone is too small to tell. Rotating the image by the
 * negative of this angle levels the rows.
 */
export function zoneSkew(img: Image, quad: Point[]): number | undefined {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(img.width - 1, Math.ceil(Math.max(...xs)));
  const width = x1 - x0;
  if (width < 60) return undefined;
  const xc = (x0 + x1) / 2;
  const yc = ys.reduce((a, b) => a + b, 0) / ys.length;
  // The bars are about a tenth of the code width tall, and the quad can sit
  // anywhere on them. This takes in the bars, the digits and the caption.
  const half = Math.round(width * 0.14);
  const y0 = Math.max(0, Math.round(yc - half));
  const y1 = Math.min(img.height - 1, Math.round(yc + half));
  if (y1 - y0 < 16) return undefined;

  // Signed vertical gradient of each pixel. Flat areas, light or dark, give
  // nothing: the table next to the form is dark and would outweigh the zone.
  const lum = (x: number, y: number) => {
    const o = (y * img.width + x) * 4;
    return (img.data[o] * 299 + img.data[o + 1] * 587 + img.data[o + 2] * 114) / 1000;
  };
  const pts: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const g = lum(x, y + 1) - lum(x, y);
      if (Math.abs(g) >= 8) pts.push(x - xc, y - y0, g);
    }
  }
  const pad = Math.ceil((width / 2) * Math.tan((MAX_DEG * Math.PI) / 180)) + 2;
  const bins = new Float64Array(y1 - y0 + pad * 2 + 2);

  // Sum of squares of the row profile of edges: it peaks when the edges line up along rows.
  const score = (deg: number): number => {
    const t = Math.tan((deg * Math.PI) / 180);
    bins.fill(0);
    for (let i = 0; i < pts.length; i += 3) {
      // A row turned clockwise by deg drops by dx*tan(deg) to the right of the center.
      // Nearest bin, not split between two: splitting lowers the sum except at
      // 0 degrees, where every pixel lands on a bin, and that pulled results to 0.
      bins[Math.round(pts[i + 1] - pts[i] * t + pad)] += pts[i + 2];
    }
    let s = 0;
    for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i];
    return s;
  };

  // Nearest-bin rounding makes neighboring angles tie: a 900 px zone moves
  // no pixel to another row until the angle changes by about 0.06 degrees.
  // The middle of the tied run is the estimate.
  const search = (from: number, to: number, step: number): number => {
    const ds: number[] = [];
    const ss: number[] = [];
    for (let d = from; d <= to + 1e-9; d += step) {
      ds.push(d);
      ss.push(score(d));
    }
    const max = Math.max(...ss);
    const first = ss.findIndex((s) => s >= max * (1 - 1e-12));
    let last = first;
    while (last + 1 < ss.length && ss[last + 1] >= max * (1 - 1e-12)) last++;
    return (ds[first] + ds[last]) / 2;
  };
  const coarse = search(-MAX_DEG, MAX_DEG, 0.2);
  const fine = search(coarse - 0.2, coarse + 0.2, 0.02);
  return Math.round(fine * 100) / 100;
}

/**
 * Where a point lands when the image is turned by `deg` clockwise about its
 * center into a canvas of the turned size, as `rotateCanvas` in main.ts does.
 */
export function rotatePoint(p: Point, srcW: number, srcH: number, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const { w, h } = rotatedSize(srcW, srcH, deg);
  const dx = p.x - srcW / 2;
  const dy = p.y - srcH / 2;
  return { x: dx * cos - dy * sin + w / 2, y: dx * sin + dy * cos + h / 2 };
}

export function rotatedSize(w: number, h: number, deg: number): { w: number; h: number } {
  const r = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  return { w: Math.round(w * cos + h * sin), h: Math.round(w * sin + h * cos) };
}
