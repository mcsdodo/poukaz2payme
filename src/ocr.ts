// Tesseract.js, fully self-hosted: worker, core and traineddata are copied
// into /vendor at build time (scripts/copy-assets.mjs). Nothing leaves the device.

import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { gridTiles, segmentCells, voteCells, voteCellsAt, type CellReading, type GridTile } from "./cells";
import { accented } from "./text";
import type { BBox, OcrLine } from "./extract";

export type Progress = (status: string, progress: number) => void;

let workerPromise: Promise<Worker> | undefined;
let progressCb: Progress = () => {};

export function setOcrProgress(cb: Progress): void {
  progressCb = cb;
}

export function getOcrWorker(): Promise<Worker> {
  if (!workerPromise) {
    const base = new URL("vendor/", document.baseURI).href;
    workerPromise = createWorker(["slk", "eng"], OEM.LSTM_ONLY, {
      workerPath: base + "tesseract/worker.min.js",
      corePath: base + "tesseract-core/",
      langPath: base + "lang",
      gzip: true,
      workerBlobURL: false,
      logger: (m) => progressCb(m.status, m.progress),
    });
    workerPromise.catch(() => {
      workerPromise = undefined;
    });
  }
  return workerPromise;
}

export interface PageOcr {
  text: string;
  lines: OcrLine[];
  ms: number;
}

export async function ocrPage(canvas: HTMLCanvasElement): Promise<PageOcr> {
  const t0 = performance.now();
  const w = await getOcrWorker();
  await w.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    tessedit_char_whitelist: "",
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
  const lines: OcrLine[] = [];
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs) {
      for (const l of p.lines) {
        lines.push({ text: l.text.trim(), bbox: l.bbox, confidence: l.confidence });
      }
    }
  }
  return { text: data.text, lines: lines.filter((l) => l.text), ms: Math.round(performance.now() - t0) };
}

/**
 * Digit-only pass on one rectangle, for boxed symbols and the amount.
 * Returns the digits (and "," for amounts) with Tesseract's confidence.
 */
export async function ocrDigits(
  canvas: HTMLCanvasElement,
  rect: BBox,
  allowComma: boolean,
): Promise<{ text: string; confidence: number }> {
  const w = await getOcrWorker();
  const left = Math.max(0, Math.round(rect.x0));
  const top = Math.max(0, Math.round(rect.y0));
  const width = Math.min(canvas.width - left, Math.round(rect.x1 - rect.x0));
  const height = Math.min(canvas.height - top, Math.round(rect.y1 - rect.y0));
  if (width < 8 || height < 8) return { text: "", confidence: 0 };
  await w.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: allowComma ? "0123456789,.=" : "0123456789",
  });
  const { data } = await w.recognize(canvas, { rectangle: { left, top, width, height } });
  return { text: data.text.replace(/\s/g, ""), confidence: data.confidence };
}

/** Text height a line is scaled to for `ocrLine`, in px. */
const LINE_TEXT_HEIGHT = 48;

/**
 * Reads one line of text again from its own crop, scaled to a fixed text
 * height and read as a single line: a second reading, with other mistakes
 * than the page's, for the vote in vote.ts.
 */
export async function ocrLine(
  canvas: HTMLCanvasElement,
  box: BBox,
  /** Margin above and below, as a share of the box height. A box known tight to its line, with
   * the next line right under it, takes a small one. */
  padY = 0.3,
): Promise<{ text: string; confidence: number }> {
  const h = box.y1 - box.y0;
  const left = Math.max(0, Math.round(box.x0 - h * 0.5));
  const top = Math.max(0, Math.round(box.y0 - h * padY));
  const width = Math.min(canvas.width - left, Math.round(box.x1 - box.x0 + h));
  const height = Math.min(canvas.height - top, Math.round(h * (1 + padY * 2)));
  if (width < 8 || height < 8) return { text: "", confidence: 0 };
  const scale = LINE_TEXT_HEIGHT / h;
  const pad = 24;
  const c = document.createElement("canvas");
  c.width = Math.round(width * scale) + pad * 2;
  c.height = Math.round(height * scale) + pad * 2;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, left, top, width, height, pad, pad, c.width - pad * 2, c.height - pad * 2);
  const w = await getOcrWorker();
  await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: "", user_defined_dpi: "300" });
  const { data } = await w.recognize(c);
  return { text: data.text.replace(/\s+/g, " ").trim(), confidence: data.confidence };
}

/** Thresholds to try, as a fraction of the paper brightness. Tested on the real form. */
const CELL_THRESHOLDS = [0.5, 0.4, 0.6];
const CELL_SCALE = 3;
/** Crop height after scaling, in px. The digits are then about 85 px tall. */
const CELL_CROP_HEIGHT = 230;
const MIN_CELL_CONFIDENCE = 70;

export interface BoxedRead {
  text: string;
  confidence: number;
  threshold?: number;
  /** The grid's voted digits with "?" where unreadable: a fallback reading must fit it. */
  pattern?: string;
  /** Per box: the digit, null when unreadable, undefined when empty (ocrGridDigits only). */
  boxes?: (string | null | undefined)[];
  attempts: string[];
  /** Readings with every character found but some unreadable, as null. */
  partials: (string | null)[][];
  /** How far the grid was moved onto the printed characters, in the input's pixels (ocrGridDigits only). */
  shift?: number;
}

function isGoodCell(c: { ch: string; confidence: number }): boolean {
  return c.ch.length === 1 && c.confidence >= MIN_CELL_CONFIDENCE;
}

/**
 * A printed digit this narrow is a 1: every other digit is 0.6 of its height
 * or wider, a 1 about 0.35. Tesseract read a clean, isolated 1 as 4 at 84.
 */
const NARROW = 0.45;

/**
 * Each page mode returns nothing for some clean characters, and not the same ones.
 * A narrow shape read as anything but 1 tries the other modes, and is unreadable
 * when none of them says 1: an empty field is better than a wrong one.
 */
async function readCell(w: Worker, tile: HTMLCanvasElement, aspect: number): Promise<{ ch: string; confidence: number }> {
  const narrow = aspect < NARROW;
  let last = { ch: "", confidence: 0 };
  let misread: string | undefined;
  for (const mode of [PSM.SINGLE_CHAR, PSM.SINGLE_WORD, PSM.SINGLE_BLOCK]) {
    await w.setParameters({ tessedit_pageseg_mode: mode });
    const { data } = await w.recognize(tile);
    last = { ch: data.text.trim(), confidence: data.confidence };
    if (!isGoodCell(last)) continue;
    if (!narrow || last.ch === "1") return last;
    misread ??= last.ch;
  }
  return misread ? { ch: `${misread}?`, confidence: 0 } : last;
}

/**
 * Reads a boxed number one character at a time, at several ink thresholds.
 * Two complete readings that agree settle it; otherwise every threshold is
 * read and the characters are voted (voteCells). The result counts only when
 * every character is known. Takes the color image, because the cell borders
 * are in the printed form color.
 */
export async function ocrBoxedDigits(
  canvas: HTMLCanvasElement,
  rect: BBox,
  maxLen: number,
  plausible: (text: string) => boolean = () => true,
  /** Fewer characters is a reading that lost some, not a short number: a KS always prints 4. */
  minLen = 1,
): Promise<BoxedRead> {
  const left = Math.max(0, Math.round(rect.x0));
  const top = Math.max(0, Math.round(rect.y0));
  const width = Math.min(canvas.width - left, Math.round(rect.x1 - rect.x0));
  const height = Math.min(canvas.height - top, Math.round(rect.y1 - rect.y0));
  if (width < 8 || height < 8) return { text: "", confidence: 0, attempts: [], partials: [] };

  // Scale to a fixed crop height: at 3x a smaller photo gave 54 px digits, and a clean 1 read as 4.
  const scale = Math.max(CELL_SCALE, CELL_CROP_HEIGHT / height);
  const crop = document.createElement("canvas");
  crop.width = Math.round(width * scale);
  crop.height = Math.round(height * scale);
  const ctx = crop.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, left, top, width, height, 0, 0, crop.width, crop.height);
  const img = ctx.getImageData(0, 0, crop.width, crop.height);

  const w = await getOcrWorker();
  await w.setParameters({ tessedit_char_whitelist: "0123456789", user_defined_dpi: "300" });
  const attempts: string[] = [];
  const readings: (CellReading & { k: number; confidence: number })[] = [];
  const complete = (r: CellReading) => r.cells.every((c) => c.ch !== null);
  const textOf = (r: CellReading) => r.cells.map((c) => c.ch ?? "?").join("");
  for (const k of CELL_THRESHOLDS) {
    const tiles = segmentCells(img, k);
    if (!tiles.length || tiles.length > maxLen) {
      attempts.push(`${k}: ${tiles.length} shapes`);
      continue;
    }
    const reading: CellReading & { k: number; confidence: number } = { k, confidence: 100, cells: [] };
    const read: string[] = [];
    for (const t of tiles) {
      const c = document.createElement("canvas");
      c.width = t.width;
      c.height = t.height;
      c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
      const cell = await readCell(w, c, t.aspect);
      read.push(`${cell.ch || "?"}(${Math.round(cell.confidence)})`);
      const good = isGoodCell(cell);
      if (good) reading.confidence = Math.min(reading.confidence, cell.confidence);
      reading.cells.push({ center: t.center, inkHeight: t.inkHeight, ch: good ? cell.ch : null });
    }
    attempts.push(`${k}: ${read.join(" ")}`);
    readings.push(reading);
    // Two complete readings that agree: no third threshold can outvote them. An implausible
    // pair (a KS of no known class) still lets the third threshold join the vote.
    const done = readings.filter(complete);
    if (done.length >= 2 && done.every((r) => textOf(r) === textOf(done[0])) && plausible(textOf(done[0]))) break;
  }

  const cells = voteCells(readings);
  const partials = cells.includes(null) && cells.length === maxLen ? [cells] : [];
  const text = cells.includes(null) ? "" : cells.join("");
  if (readings.length > 1) attempts.push(`vote: ${cells.map((c) => c ?? "?").join("")}`);
  if (!text || text.length < minLen) return { text: "", confidence: 0, attempts, partials };
  // The weakest character of the readings that agree with the result.
  const agreeing = readings.filter((r) => complete(r) && textOf(r) === text);
  const confidence = agreeing.length ? Math.max(...agreeing.map((r) => r.confidence)) : MIN_CELL_CONFIDENCE;
  // A confident but implausible reading is still the best evidence: keep it, the caller flags it.
  return { text, confidence, threshold: agreeing[0]?.k, attempts, partials };
}

/** Height a box is scaled to before its characters are cut out, in px. */
const GRID_CELL_HEIGHT = 130;

/** The boxes' area of the color image, scaled, with the boxes in crop pixels. */
function cropGrid(canvas: HTMLCanvasElement, cells: BBox[]): { img: ImageData; cells: BBox[]; scale: number } | undefined {
  const pitch = (cells[cells.length - 1].x1 - cells[0].x0) / cells.length;
  const top = Math.min(...cells.map((c) => c.y0));
  const bottom = Math.max(...cells.map((c) => c.y1));
  const h = bottom - top;
  // A margin around the grid: shapes cut by the crop's edge are dropped, so a letter
  // the fit placed a little outside its boxes must still be whole in the crop.
  // 1.6 boxes: a grid placed a box out must see the letters it would leave outside (gridTiles).
  const left = Math.max(0, Math.floor(cells[0].x0 - pitch * 1.6));
  const right = Math.min(canvas.width, Math.ceil(cells[cells.length - 1].x1 + pitch * 1.6));
  const y0 = Math.max(0, Math.floor(top - h * 0.3));
  const y1 = Math.min(canvas.height, Math.ceil(bottom + h * 0.3));
  if (right - left < 8 || y1 - y0 < 8) return undefined;
  const scale = GRID_CELL_HEIGHT / h;
  const c = document.createElement("canvas");
  c.width = Math.round((right - left) * scale);
  c.height = Math.round((y1 - y0) * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, left, y0, right - left, y1 - y0, 0, 0, c.width, c.height);
  return {
    scale,
    img: ctx.getImageData(0, 0, c.width, c.height),
    cells: cells.map((b) => ({ x0: (b.x0 - left) * scale, y0: (b.y0 - y0) * scale, x1: (b.x1 - left) * scale, y1: (b.y1 - y0) * scale })),
  };
}

function tileCanvas(t: GridTile): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = t.width;
  c.height = t.height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
  return c;
}

/**
 * A boxed number read from its own boxes (layout.ts FIELDS), one digit per box,
 * at several thresholds voted by box (voteCells). Empty boxes are skipped: VS
 * prints its digits right-aligned.
 */
export async function ocrGridDigits(
  canvas: HTMLCanvasElement,
  cells: BBox[],
  plausible: (text: string) => boolean = () => true,
  minLen = 1,
): Promise<BoxedRead> {
  const crop = cropGrid(canvas, cells);
  if (!crop) return { text: "", confidence: 0, attempts: [], partials: [] };
  const w = await getOcrWorker();
  await w.setParameters({ tessedit_char_whitelist: "0123456789", user_defined_dpi: "300" });
  const attempts: string[] = [];
  const readings: (CellReading & { k: number; confidence: number })[] = [];
  const complete = (r: CellReading) => r.cells.every((c) => c.ch !== null);
  const textOf = (r: CellReading) => r.cells.map((c) => c.ch ?? "?").join("");
  // The first threshold places the grid; the others keep that placement, so their readings
  // stay box for box (placed on their own, two of three once sat a box apart).
  let gridOffset: number | undefined;
  for (const k of CELL_THRESHOLDS) {
    const grid = gridTiles(crop.img, crop.cells, k, gridOffset);
    gridOffset ??= grid.offset;
    const tiles = grid.tiles;
    const reading: CellReading & { k: number; confidence: number } = { k, confidence: 100, cells: [] };
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      // No digit is wider than tall: a wide shape is the amount's "=" or a scrap of a rule.
      if (!t || t.aspect > 1.2) continue;
      const cell = await readCell(w, tileCanvas(t), t.aspect);
      const good = isGoodCell(cell);
      if (good) reading.confidence = Math.min(reading.confidence, cell.confidence);
      // Matched by box, not by pixel: one box is one place in the vote.
      reading.cells.push({ center: i * 100, inkHeight: 100, ch: good ? cell.ch : null });
    }
    attempts.push(`${k}: ${tiles.map((t, i) => (t ? (reading.cells.find((c) => c.center === i * 100)?.ch ?? "?") : "_")).join("")}`);
    if (!reading.cells.length) continue;
    readings.push(reading);
    const done = readings.filter(complete);
    if (done.length >= 2 && done.every((r) => textOf(r) === textOf(done[0])) && plausible(textOf(done[0]))) break;
  }
  const placed = voteCellsAt(readings);
  const voted = placed.map((p) => p.ch);
  const boxes: (string | null | undefined)[] = cells.map(() => undefined);
  for (const p of placed) boxes[Math.round(p.center / 100)] = p.ch;
  const partials = voted.includes(null) && voted.length === cells.length ? [voted] : [];
  const text = voted.includes(null) ? "" : voted.join("");
  const pattern = voted.map((c) => c ?? "?").join("") || undefined;
  if (readings.length > 1) attempts.push(`vote: ${pattern ?? ""}`);
  const shift = (gridOffset ?? 0) / crop.scale;
  if (!text || text.length < minLen) return { text: "", confidence: 0, pattern, boxes, attempts, partials, shift };
  const agreeing = readings.filter((r) => complete(r) && textOf(r) === text);
  const confidence = agreeing.length ? Math.max(...agreeing.map((r) => r.confidence)) : MIN_CELL_CONFIDENCE;
  return { text, confidence, threshold: agreeing[0]?.k, pattern, boxes, attempts, partials, shift };
}

const LETTERS = "AÁÄBCČDĎEÉFGHIÍJKLĹĽMNŇOÓÔPQRŔSŠTŤUÚVWXYÝZŽaáäbcčdďeéfghiíjklĺľmnňoóôpqrŕsštťuúvwxyýzž0123456789";
/** Letters whose small form is a smaller copy of the capital: alone, only the height tells them apart. */
const SAME_SHAPE = new Set([..."cčoóôsšvwxzž"]);
const MIN_CHAR_CONFIDENCE = 50;

async function readLetter(w: Worker, tile: HTMLCanvasElement): Promise<{ ch: string; confidence: number }> {
  let best = { ch: "", confidence: 0 };
  for (const mode of [PSM.SINGLE_CHAR, PSM.SINGLE_WORD, PSM.SINGLE_BLOCK]) {
    await w.setParameters({ tessedit_pageseg_mode: mode });
    const { data } = await w.recognize(tile);
    const ch = data.text.trim();
    if (ch.length === 1 && data.confidence > best.confidence) best = { ch, confidence: data.confidence };
    if (best.confidence >= 75) break;
  }
  return best;
}

export interface GridText {
  text: string;
  /** The weakest character. */
  confidence: number;
  /** Per box: the character, "_" for an empty box, "?" when unreadable. */
  boxes: string;
  /** Per box: the letter's width x height and its marks, for the diagnostics. */
  shapes: string;
}

/**
 * Text printed one character per box, as the message is: each box read alone,
 * an empty box a space. Punctuation is told by its shape: a short flat mark is
 * a hyphen, a short mark at the foot of the letters a comma or a full stop.
 */
export async function ocrGridText(canvas: HTMLCanvasElement, cells: BBox[]): Promise<GridText> {
  const crop = cropGrid(canvas, cells);
  if (!crop) return { text: "", confidence: 0, boxes: "", shapes: "" };
  const tiles = gridTiles(crop.img, crop.cells, 0.5).tiles;
  const heights = tiles.filter((t): t is GridTile => !!t).map((t) => t.mainHeight).sort((a, b) => a - b);
  // Capitals are the tallest shapes of the row (accents are separate shapes, so they do not count).
  const cap = heights.length ? heights[Math.floor((heights.length - 1) * 0.9)] : 0;
  const tall = tiles.filter((t): t is GridTile => !!t && t.mainHeight >= cap * 0.6);
  const foot = tall.length ? tall.map((t) => t.middle + t.mainHeight / 2).sort((a, b) => a - b)[tall.length >> 1] : 0;
  const w = await getOcrWorker();
  await w.setParameters({ tessedit_char_whitelist: LETTERS, user_defined_dpi: "300" });
  const chars: { ch: string; confidence: number; lower?: boolean }[] = [];
  for (const t of tiles) {
    if (!t) {
      chars.push({ ch: " ", confidence: 100 });
      continue;
    }
    const inkW = t.aspect * t.inkHeight;
    if (t.mainHeight < cap * 0.45) {
      // By shape: in this font the hyphen sits low, so the height above the foot misled.
      chars.push({ ch: inkW >= t.inkHeight * 1.5 ? "-" : t.inkHeight >= inkW * 1.3 ? "," : ".", confidence: 90 });
      continue;
    }
    // A bare vertical bar: Tesseract returns nothing for it alone. l or I, the neighbours decide.
    // With no letter on either side it is a stub of a rule (the column's border, 5x55 in the
    // last box of an empty row end), not a one-letter word.
    if (t.parts === 1 && t.mainWidth <= t.mainHeight * 0.25) {
      const i = chars.length;
      const lone = !tiles[i - 1] && !tiles[i + 1];
      chars.push(lone ? { ch: " ", confidence: 100 } : { ch: "I", confidence: 80 });
      continue;
    }
    const r = await readLetter(w, tileCanvas(t));
    if (!r.ch || r.confidence < MIN_CHAR_CONFIDENCE) {
      chars.push({ ch: "?", confidence: r.confidence });
      continue;
    }
    const lower = t.mainHeight < cap * 0.8;
    let ch = SAME_SHAPE.has(r.ch.toLowerCase()) ? (lower ? r.ch.toLowerCase() : r.ch.toUpperCase()) : r.ch;
    // Tesseract reads a lone é as e and Ý as Y. The cut-out knows there is a mark above
    // the letter: a vowel takes an acute, a consonant a caron. Accents are only added.
    // A caron touching its letter is no separate mark, but the letter stands taller than the
    // row's capitals (Š at 55 px against 44): the accent is there all the same.
    const marks = t.marks || (t.mainHeight > cap * 1.15 ? 1 : 0);
    if (marks && ch.normalize("NFD").length === 1) ch = accented(ch, marks);
    chars.push({ ch, confidence: r.confidence, lower });
  }
  // An unreadable box between empty ones (or the row's end) is a stub of a rule or a speck,
  // not a letter of the message: the column's border left one in the last box of a row.
  for (let i = 0; i < chars.length; i++) {
    const blank = (c?: { ch: string }) => !c || c.ch === " ";
    if (chars[i].ch === "?" && blank(chars[i - 1]) && blank(chars[i + 1])) chars[i] = { ch: " ", confidence: 100 };
  }
  // l and I are one shape in this font: the letters next to it decide (Malé, RICH).
  const isLetter = (c: string) => /\p{L}/u.test(c) && !"lI".includes(c);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i].ch !== "l" && chars[i].ch !== "I") continue;
    const near = [chars[i - 1], chars[i + 1]].filter((c) => c && isLetter(c.ch)).map((c) => c!.ch);
    if (near.length) chars[i].ch = near.some((c) => c === c.toLowerCase()) ? "l" : "I";
  }
  const boxes = chars.map((c) => (c.ch === " " ? "_" : c.ch)).join("");
  const shapes = tiles.map((t) => (t ? `${t.mainWidth}x${t.mainHeight}${t.marks ? "+" + t.marks : ""}` : "_")).join(" ");
  return {
    text: chars.map((c) => c.ch).join(""),
    confidence: Math.min(100, ...chars.map((c) => c.confidence)),
    boxes,
    shapes: `cap ${cap}: ${shapes}`,
  };
}
