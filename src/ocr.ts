// Tesseract.js, fully self-hosted: worker, core and traineddata are copied
// into /vendor at build time (scripts/copy-assets.mjs). Nothing leaves the device.

import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { segmentCells, voteCells, type CellReading } from "./cells";
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
export async function ocrLine(canvas: HTMLCanvasElement, box: BBox): Promise<{ text: string; confidence: number }> {
  const h = box.y1 - box.y0;
  const left = Math.max(0, Math.round(box.x0 - h * 0.5));
  const top = Math.max(0, Math.round(box.y0 - h * 0.3));
  const width = Math.min(canvas.width - left, Math.round(box.x1 - box.x0 + h));
  const height = Math.min(canvas.height - top, Math.round(h * 1.6));
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
  attempts: string[];
  /** Readings with every character found but some unreadable, as null. */
  partials: (string | null)[][];
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
