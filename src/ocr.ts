// Tesseract.js, fully self-hosted: worker, core and traineddata are copied
// into /vendor at build time (scripts/copy-assets.mjs). Nothing leaves the device.

import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { segmentCells } from "./cells";
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

/** Each page mode returns nothing for some clean characters, and not the same ones. */
async function readCell(w: Worker, tile: HTMLCanvasElement): Promise<{ ch: string; confidence: number }> {
  let last = { ch: "", confidence: 0 };
  for (const mode of [PSM.SINGLE_CHAR, PSM.SINGLE_WORD, PSM.SINGLE_BLOCK]) {
    await w.setParameters({ tessedit_pageseg_mode: mode });
    const { data } = await w.recognize(tile);
    last = { ch: data.text.trim(), confidence: data.confidence };
    if (isGoodCell(last)) break;
  }
  return last;
}

/**
 * Reads a boxed number one character at a time. A reading that fails
 * `plausible` does not stop the search for a better threshold. The result counts only when
 * every character is confident, otherwise the next threshold is tried. Takes
 * the color image, because the cell borders are in the printed form color.
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
  const partials: (string | null)[][] = [];
  let firstRead: { text: string; confidence: number; threshold: number } | undefined;
  for (const k of CELL_THRESHOLDS) {
    const tiles = segmentCells(img, k);
    if (!tiles.length || tiles.length > maxLen) {
      attempts.push(`${k}: ${tiles.length} shapes`);
      continue;
    }
    const cells: (string | null)[] = [];
    let confidence = 100;
    const read: string[] = [];
    for (const t of tiles) {
      const c = document.createElement("canvas");
      c.width = t.width;
      c.height = t.height;
      c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
      const cell = await readCell(w, c);
      read.push(`${cell.ch || "?"}(${Math.round(cell.confidence)})`);
      if (isGoodCell(cell)) {
        cells.push(cell.ch);
        confidence = Math.min(confidence, cell.confidence);
      } else {
        cells.push(null);
      }
    }
    attempts.push(`${k}: ${read.join(" ")}`);
    if (cells.includes(null)) {
      if (cells.length === maxLen) partials.push(cells);
      continue;
    }
    const text = cells.join("");
    if (text.length < minLen) continue;
    if (plausible(text)) return { text, confidence, threshold: k, attempts, partials };
    firstRead ??= { text, confidence, threshold: k };
  }
  // A confident but implausible reading is still the best evidence: keep it, the caller flags it.
  return firstRead ? { ...firstRead, attempts, partials } : { text: "", confidence: 0, attempts, partials };
}
