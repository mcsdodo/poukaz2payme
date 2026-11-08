// Barcode decoding: native BarcodeDetector first (free on Chrome Android),
// then zxing-wasm in a Web Worker.

import type { WorkerHit } from "./barcode.worker";

export interface BarcodeHit extends WorkerHit {
  engine: "native" | "zxing";
}

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, (hits: WorkerHit[], error?: string) => void>();
export let lastZxingError: string | undefined;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./barcode.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<{ id: number; hits: WorkerHit[]; error?: string }>) => {
      const cb = pending.get(ev.data.id);
      pending.delete(ev.data.id);
      cb?.(ev.data.hits, ev.data.error);
    };
    worker.onerror = (ev) => {
      lastZxingError = ev.message || "worker error";
      for (const cb of pending.values()) cb([], lastZxingError);
      pending.clear();
    };
  }
  return worker;
}

/** Start the worker (and its wasm download) early. */
export function warmUpBarcode(): void {
  const c = new OffscreenCanvas(8, 8).getContext("2d")!;
  void zxingDecode(c.getImageData(0, 0, 8, 8));
}

function zxingDecode(image: ImageData): Promise<WorkerHit[]> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, (hits, error) => {
      if (error) lastZxingError = error;
      resolve(hits);
    });
    getWorker().postMessage({ id, image }, [image.data.buffer]);
  });
}

// BarcodeDetector types are not in lib.dom for every TS version.
interface NativeDetected {
  rawValue: string;
  format: string;
  cornerPoints: { x: number; y: number }[];
}
interface NativeDetector {
  detect(src: ImageBitmapSource): Promise<NativeDetected[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts: { formats: string[] }): NativeDetector;
      getSupportedFormats(): Promise<string[]>;
    };
  }
}

let native: NativeDetector | null | undefined;
export let nativeFormats: string[] = [];

async function getNative(): Promise<NativeDetector | null> {
  if (native !== undefined) return native;
  native = null;
  try {
    if (window.BarcodeDetector) {
      nativeFormats = await window.BarcodeDetector.getSupportedFormats();
      if (nativeFormats.includes("code_128")) {
        const want = ["code_128", "data_matrix", "qr_code"].filter((f) => nativeFormats.includes(f));
        native = new window.BarcodeDetector({ formats: want });
      }
    }
  } catch {
    native = null;
  }
  return native;
}

const NATIVE_FORMAT: Record<string, string> = {
  code_128: "Code128",
  data_matrix: "DataMatrix",
  qr_code: "QRCode",
};

/** Decode from a canvas. Native first; zxing when native finds nothing. */
export async function decodeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<BarcodeHit[]> {
  const det = await getNative();
  if (det) {
    try {
      const found = await det.detect(canvas);
      if (found.length) {
        return found.map((f) => ({
          engine: "native",
          format: NATIVE_FORMAT[f.format] ?? f.format,
          text: f.rawValue,
          orientation: orientationFromCorners(f.cornerPoints),
          position: f.cornerPoints,
        }));
      }
    } catch {
      // fall through to zxing
    }
  }
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const hits = await zxingDecode(img);
  return hits.map((h) => ({ ...h, engine: "zxing" as const }));
}

/** Angle of the top edge in degrees, rounded to a multiple of 90. */
export function orientationFromCorners(pts: { x: number; y: number }[]): number {
  if (pts.length < 2) return 0;
  const a = (Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180) / Math.PI;
  return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
}

/**
 * Two reads of the code in consecutive frames at the same place and size: the
 * phone is holding still. The first decodable frame is often still moving or
 * focusing, because the barcode decodes before the small text is sharp.
 */
export function isSteady(prev: { x: number; y: number }[], cur: { x: number; y: number }[], frameWidth: number): boolean {
  if (prev.length < 2 || cur.length < 2) return false;
  const center = (q: { x: number; y: number }[]) => ({
    x: q.reduce((s, p) => s + p.x, 0) / q.length,
    y: q.reduce((s, p) => s + p.y, 0) / q.length,
  });
  const width = (q: { x: number; y: number }[]) => Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
  const a = center(prev);
  const b = center(cur);
  const wa = width(prev);
  const wb = width(cur);
  return Math.hypot(a.x - b.x, a.y - b.y) <= frameWidth * 0.02 && Math.abs(wa - wb) <= Math.max(wa, wb) * 0.05;
}
