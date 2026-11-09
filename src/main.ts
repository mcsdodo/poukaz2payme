import "@fontsource/ibm-plex-sans-condensed/400.css";
import "@fontsource/ibm-plex-sans-condensed/500.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./style.css";
import QRCode from "qrcode";
import { decode as decodeBySquare } from "bysquare/pay";
import { rotatePoint, rotatedSize, zoneSkew, type Point } from "./deskew";
import { decodeCanvas, isSteady, lastZxingError, nativeFormats, orientationFromCorners, warmUpBarcode, type BarcodeHit } from "./barcode";
import { extractFields, type BBox, type Extracted, type ExtractResult } from "./extract";
import { bankName, formatIban, isValidIban, normalizeIban, splitSkIban, isValidLegacyPart } from "./iban";
import { flattenLight } from "./light";
import { locateBarcode } from "./locate";
import { getOcrWorker, ocrBoxedDigits, ocrDigits, ocrGridDigits, ocrGridText, ocrLine, ocrPage, setOcrProgress } from "./ocr";
import { FIELDS, gridCells } from "./layout";
import { consensus, type Reading } from "./vote";
import { buildBySquare, buildPaymeLink, formatAmount, parseAmount, PaymeError } from "./payme";
import { completeKs, isKnownKsClass } from "./ks";
import { parsePoukazBarcode, productAdvice, type PoukazBarcode } from "./poukaz";

declare const __BUILD_TIME__: string;
declare const __APP_VERSION__: string;

// ---------- DOM helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const views = ["start", "camera", "work", "result"] as const;
type View = (typeof views)[number];
function show(v: View): void {
  // Landscape is for aiming the camera only; every other view is laid out for portrait.
  if (v !== "camera") leaveLandscape();
  document.body.classList.toggle("camera-on", v === "camera");
  for (const name of views) $(`view-${name}`).hidden = name !== v;
  window.scrollTo(0, 0);
}

const STEPS = ["load", "barcode", "ocr", "digits"] as const;
function step(name: (typeof STEPS)[number]): void {
  const at = STEPS.indexOf(name);
  document.querySelectorAll<HTMLLIElement>("#steps li").forEach((li) => {
    const i = STEPS.indexOf(li.dataset.step as (typeof STEPS)[number]);
    li.classList.toggle("done", i < at);
    li.classList.toggle("active", i === at);
  });
}

function setWork(status: string, progress?: number): void {
  $("work-status").textContent = status;
  const p = $<HTMLProgressElement>("work-progress");
  if (progress === undefined) p.removeAttribute("value");
  else p.value = progress;
}

// ---------- State ----------

type FieldKey = "iban" | "amount" | "vs" | "ss" | "ks" | "name" | "message" | "due";
type Source = "barcode" | "qr" | "ocr" | "manual" | "none";
type Level = "high" | "medium" | "low";

interface FieldState {
  value: string;
  source: Source;
  level?: Level;
  crop?: string;
  note?: string;
}

interface Alert {
  level: "info" | "warn" | "block";
  text: string;
}

const state = {
  fields: {} as Record<FieldKey, FieldState>,
  alerts: [] as Alert[],
  blocked: false,
  diag: {} as Record<string, unknown>,
  source: null as HTMLCanvasElement | null,
  rotation: 0,
  /** The photo as shown after the last read, before any manual turn. */
  shown: null as HTMLCanvasElement | null,
  /** Degrees the operator turned the photo since the last read. */
  turn: 0,
  /** The live path that took the image, or null for a file. */
  capture: null as string | null,
};

function emptyFields(): Record<FieldKey, FieldState> {
  const keys: FieldKey[] = ["iban", "amount", "vs", "ss", "ks", "name", "message", "due"];
  return Object.fromEntries(keys.map((k) => [k, { value: "", source: "none" as Source }])) as Record<FieldKey, FieldState>;
}

// ---------- Image helpers ----------

function canvasFrom(src: CanvasImageSource, w: number, h: number, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d", { willReadFrequently: true })!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/**
 * Frees a canvas's pixels now. A phone has little canvas memory, and Chrome on
 * Android does not throw when it runs out: the next canvas just comes out blank.
 */
function release(...cs: (HTMLCanvasElement | undefined)[]): void {
  for (const c of cs) {
    if (!c) continue;
    c.width = 0;
    c.height = 0;
  }
}

/** The next canvas of a chain; the previous one is freed when it is not the same. */
function swap(prev: HTMLCanvasElement, next: HTMLCanvasElement): HTMLCanvasElement {
  if (next !== prev) release(prev);
  return next;
}

/** No pixels: the canvas could not be allocated (see `release`), or it is one flat colour. */
function isBlank(c: HTMLCanvasElement): boolean {
  if (!c.width || !c.height) return true;
  const probe = document.createElement("canvas");
  probe.width = probe.height = 48;
  const ctx = probe.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(c, 0, 0, 48, 48);
  const d = ctx.getImageData(0, 0, 48, 48).data;
  let lo = 255;
  let hi = 0;
  let alpha = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    alpha = Math.max(alpha, d[i + 3]);
  }
  return alpha === 0 || hi - lo < 8;
}

/** Turns clockwise by any angle. The corners a small turn uncovers are white, like paper. */
function rotateCanvas(src: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return src;
  const c = document.createElement("canvas");
  const size = rotatedSize(src.width, src.height, d);
  c.width = size.w;
  c.height = size.h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  if (d % 90 !== 0) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = "high";
  }
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Width the form is scaled to for OCR. The real form read every field at 1930 px. */
const FORM_WIDTH = 2200;
/** The form is about this many code widths wide: 0.85 left of the code, 0.2 right. */
const FORM_PER_CODE = 2.05;
const MAX_FORM_UPSCALE = 3;

/**
 * Cuts the form out by the barcode, with a wide margin, and scales it so the
 * form is FORM_WIDTH wide. A video frame or a photo from a distance puts the
 * form at about 1000 px, where Tesseract lost almost every field; the same
 * frame upscaled read the amount, KS and name. A large photo is not shrunk whole
 * first, so the form keeps its pixels. `quad` is level, the code below the fields.
 */
function cropToForm(src: HTMLCanvasElement, quad: Point[]): { canvas: HTMLCanvasElement; note: string; code: BBox } {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const code = Math.max(...xs) - Math.min(...xs);
  // The wanted area, which can reach past the photo: a form that fills the frame has its
  // stub at the photo's edge. That part stays white: with it, the stub's name line on one
  // photo read in full ("SPOJENÁ" where it had read "SF OJENÁ").
  const wx0 = Math.floor(Math.min(...xs) - code * 1.15);
  const wx1 = Math.ceil(Math.max(...xs) + code * 0.45);
  const wy0 = Math.floor(Math.min(...ys) - code * 1.15);
  const wy1 = Math.ceil(Math.max(...ys) + code * 0.35);
  const x0 = Math.max(0, wx0);
  const x1 = Math.min(src.width, wx1);
  const y0 = Math.max(0, wy0);
  const y1 = Math.min(src.height, wy1);
  // A white margin of a tenth of the code width is enough; more only costs OCR time.
  const margin = code * 0.1;
  const left = Math.min(x0 - wx0, margin);
  const right = Math.min(wx1 - x1, margin);
  const top = Math.min(y0 - wy0, margin);
  const bottom = Math.min(wy1 - y1, margin);
  const scale = Math.min(MAX_FORM_UPSCALE, FORM_WIDTH / (code * FORM_PER_CODE));
  const c = document.createElement("canvas");
  c.width = Math.round((x1 - x0 + left + right) * scale);
  c.height = Math.round((y1 - y0 + top + bottom) * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, left * scale, top * scale, (x1 - x0) * scale, (y1 - y0) * scale);
  const pads = [left, top, right, bottom].map((p) => Math.round(p * scale)).join("/");
  // The code in the crop's pixels, for placing the template when OCR reads too few labels.
  const at = (x: number, y: number) => ({ x: (x - x0 + left) * scale, y: (y - y0 + top) * scale });
  const tl = at(Math.min(...xs), Math.min(...ys));
  const br = at(Math.max(...xs), Math.max(...ys));
  const note = `${x1 - x0}x${y1 - y0} of ${src.width}x${src.height}, scale ${scale.toFixed(2)}, white l/t/r/b ${pads}`;
  return { canvas: c, note, code: { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y } };
}

/** A copy with the paper made evenly white, so a shadow does not black out half the form. */
function flattenCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = canvasFrom(src, src.width, src.height, Infinity);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  flattenLight(img);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Grayscale + contrast stretch, which helps Tesseract on phone photos. */
function prepareForOcr(src: HTMLCanvasElement): HTMLCanvasElement {
  // Same size as the color image: the cell pass uses OCR boxes on it.
  const c = canvasFrom(src, src.width, src.height, Infinity);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = g;
    hist[g | 0]++;
  }
  const total = d.length / 4;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < total * 0.01; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < total * 0.01; hi--);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Below this share of the image width a "code" is too small to be the poukaz's. */
const MIN_LOCATED_CODE = 0.12;

/** The poukaz code's corners found by its look, without decoding (locate.ts), or undefined. */
function findCode(canvas: HTMLCanvasElement): Point[] | undefined {
  const small = canvasFrom(canvas, canvas.width, canvas.height, 1000);
  const s = canvas.width / small.width;
  const box = locateBarcode(small.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, small.width, small.height));
  release(small);
  if (!box || (box.x1 - box.x0) * s < canvas.width * MIN_LOCATED_CODE) return undefined;
  return [
    { x: box.x0 * s, y: box.y0 * s },
    { x: box.x1 * s, y: box.y0 * s },
    { x: box.x1 * s, y: box.y1 * s },
    { x: box.x0 * s, y: box.y1 * s },
  ];
}

/** Smallest tilt worth a resample. 0.2 degrees moves a row 7 px across a 2000 px photo. */
const MIN_SKEW = 0.2;

/** Tilt of the form rows from the reading zone around the barcode, in degrees clockwise. */
function measureSkew(canvas: HTMLCanvasElement, quad: Point[]): number | undefined {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  // zoneSkew looks 0.14 of the code width above and below; read only that part of the canvas.
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - w * 0.16));
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(...xs)) + 2);
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(...ys) + w * 0.16));
  if (x1 - x0 < 8 || y1 - y0 < 8) return undefined;
  const img = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(x0, y0, x1 - x0, y1 - y0);
  return zoneSkew(img, quad.map((p) => ({ x: p.x - x0, y: p.y - y0 })));
}

function cropDataUrl(src: HTMLCanvasElement, b: BBox | undefined, pad = 12): string | undefined {
  if (!b) return undefined;
  const x = Math.max(0, b.x0 - pad);
  const y = Math.max(0, b.y0 - pad);
  const w = Math.min(src.width - x, b.x1 - b.x0 + pad * 2);
  const h = Math.min(src.height - y, b.y1 - b.y0 + pad * 2);
  if (w < 4 || h < 4) return undefined;
  const scale = Math.min(1, 600 / w);
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext("2d")!.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}

// ---------- Camera ----------

const DEFAULT_CAM_HINT = "Poukaz rovno a bez odleskov. Keď sa kód prečíta a telefón je v pokoji, odfotí sa sám.";

let stream: MediaStream | null = null;
let scanning = false;
let shooting = false;
let torchOn = false;

/**
 * Chrome on Android takes a full-resolution photo from the live stream
 * (ImageCapture). Safari and Firefox cannot: there the live view only has
 * video frames, which put the form at about 1000 px, half of what OCR needs.
 */
const canTakePhoto = "ImageCapture" in window;
const isPhone = matchMedia("(pointer: coarse)").matches;
/** Width of the code as a share of the frame's: at 0.3 the form fills about 65% of the frame. */
const MIN_CODE_SHARE = 0.3;

function codeShare(q: { x: number; y: number }[], frameWidth: number): number {
  return Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) / frameWidth;
}

/** Two reads of the code at one place within this time are a phone held still. */
const STEADY_WINDOW_MS = 1500;
/** After this long without a code, offer the phone's own camera app. */
const NATIVE_HINT_MS = 8000;

interface Range {
  min?: number;
  max?: number;
  step?: number;
}

/**
 * Width the photo is asked for. OCR reads at most 3200 px, and a phone's largest
 * photo (50 MP, 8160x6120) decodes to 200 MB before it is shrunk: on a phone that
 * can leave the later canvases blank.
 */
const PHOTO_WIDTH = 4096;

/** The largest value of the range up to `want`, on its steps. */
function upTo(r: Range | undefined, want: number): number | undefined {
  if (!r?.max) return undefined;
  if (r.max <= want) return r.max;
  const min = r.min ?? 0;
  const step = r.step || 1;
  return Math.max(min, min + Math.floor((want - min) / step) * step);
}

interface ImageCaptureLike {
  getPhotoCapabilities(): Promise<{ imageWidth?: Range; imageHeight?: Range; fillLightMode?: string[] }>;
  takePhoto(settings?: { imageWidth?: number; imageHeight?: number; fillLightMode?: string }): Promise<Blob>;
}

interface OrientationLock {
  lock?(o: "landscape"): Promise<void>;
  unlock?(): void;
}

/**
 * Fullscreen and landscape for the live view, on a phone. A portrait 1080x1920
 * stream puts the form at about 1000 px; a landscape one at about 1700, where
 * the code reads in every frame and the backup frame is near what OCR needs.
 * Chrome locks the orientation only in fullscreen, and fullscreen needs the
 * tap: call this before any await in the click handler. Safari cannot lock;
 * the promise then says why, and the camera runs as it is.
 */
function enterLandscape(): Promise<string> {
  const orientation = screen.orientation as unknown as OrientationLock | undefined;
  const root = document.documentElement;
  if (!isPhone) return Promise.resolve("not a phone");
  if (!orientation?.lock || !root.requestFullscreen) return Promise.resolve("no orientation lock");
  const locked = root
    .requestFullscreen({ navigationUI: "hide" })
    .then(() => orientation.lock!("landscape"))
    .then(
      () => "landscape",
      (e: unknown) => {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        return `refused: ${e instanceof Error ? e.message : String(e)}`;
      },
    );
  // The camera waits for this. A lock that never settles must not keep it from starting.
  const timeout = new Promise<string>((r) => setTimeout(() => r(`no answer in ${LOCK_WAIT_MS} ms`), LOCK_WAIT_MS));
  return Promise.race([locked, timeout]);
}

const LOCK_WAIT_MS = 2000;

function leaveLandscape(): void {
  if (!document.fullscreenElement) return;
  (screen.orientation as unknown as OrientationLock | undefined)?.unlock?.();
  void document.exitFullscreen().catch(() => {});
}

async function startCamera(): Promise<void> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Kamera vyžaduje HTTPS a podporovaný prehliadač. Použite \"Vybrať z galérie\".");
  }
  if (!stream || stream.getVideoTracks().every((t) => t.readyState === "ended")) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // 4K where the phone has it: the frame is exactly what the viewfinder shows, and at
      // 3840 px the form fills about 3400 of them. The still photo sees wider and is often
      // softer (see MIN_PHOTO_GAIN); a frame this size usually wins. Decoding downsizes to 1920.
      video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  }
  const track = stream.getVideoTracks()[0];
  track.enabled = true;
  const video = $<HTMLVideoElement>("video");
  video.srcObject = stream;
  await video.play().catch(() => {});

  const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { focusMode?: string[]; torch?: boolean };
  if (caps.focusMode?.includes("continuous")) {
    await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] }).catch(() => {});
  }
  $("btn-torch").hidden = !caps.torch;
  state.diag.camera = { settings: track.getSettings(), torch: !!caps.torch, focusModes: caps.focusMode };
}


async function setTorch(on: boolean): Promise<void> {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }).catch(() => {});
  torchOn = on;
}

function videoFrame(maxSide: number): HTMLCanvasElement | null {
  const v = $<HTMLVideoElement>("video");
  if (!v.videoWidth) return null;
  return canvasFrom(v, v.videoWidth, v.videoHeight, maxSide);
}

interface Still {
  canvas: HTMLCanvasElement;
  /** For the diagnostics: which path took it, at what size. */
  source: string;
}

/**
 * A full-resolution photo where the browser can take one. Without a size,
 * takePhoto uses whatever the browser picks, so this asks for about 4096 px.
 * A device that rejects the size gets a plain takePhoto, then the video frame.
 */
async function grabStill(): Promise<Still | null> {
  const track = stream?.getVideoTracks()[0];
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
  const errors: string[] = [];
  if (track && IC) {
    const capture = new IC(track);
    let sized: { imageWidth: number; imageHeight: number } | undefined;
    // No flash: Chrome's default lit it for the shot and the light stayed on while OCR ran.
    // A flash also puts a glare on the paper; the Svetlo button gives steady light instead.
    let light: { fillLightMode?: string } = {};
    try {
      const caps = await capture.getPhotoCapabilities();
      const width = upTo(caps.imageWidth, PHOTO_WIDTH);
      const wmax = caps.imageWidth?.max;
      const height = width && wmax && caps.imageHeight?.max ? upTo(caps.imageHeight, Math.round((width * caps.imageHeight.max) / wmax)) : undefined;
      if (width && height) sized = { imageWidth: width, imageHeight: height };
      if (caps.fillLightMode?.includes("off")) light = { fillLightMode: "off" };
    } catch (e) {
      errors.push(`capabilities: ${String(e)}`);
    }
    // About 4096 px without flash, then the browser's size without flash, then anything it takes.
    const tries: ({ imageWidth?: number; imageHeight?: number; fillLightMode?: string } | undefined)[] = [];
    if (sized) tries.push({ ...sized, ...light });
    if (light.fillLightMode) tries.push(light);
    tries.push(undefined);
    for (const settings of tries) {
      try {
        const blob = await capture.takePhoto(settings);
        const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }).catch(() => createImageBitmap(blob));
        const source = `takePhoto ${bmp.width}x${bmp.height}${settings?.imageWidth ? "" : " (default size)"}${settings?.fillLightMode ? ", no flash" : ""}`;
        const canvas = canvasFrom(bmp, bmp.width, bmp.height, 3200);
        bmp.close();
        return { canvas, source };
      } catch (e) {
        errors.push(String(e));
      }
    }
  }
  const frame = videoFrame(3200);
  if (!frame) return null;
  return { canvas: frame, source: `video ${frame.width}x${frame.height}${errors.length ? ` (takePhoto: ${errors.join("; ")})` : ""}` };
}

function isPoukazHit(h: BarcodeHit): boolean {
  if (h.format !== "Code128") return false;
  const p = parsePoukazBarcode(h.text);
  return !!p && (p.ibanValid || p.variant === "product37");
}

/** Below this many pixels on the longer side, a missed code is tried again at twice the size. */
const UPSCALE_BELOW = 2400;

/**
 * Decodes, and when the poukaz code is missing on a small image, decodes again
 * at twice the size. In a portrait 1080x1920 stream the code is about 460 px
 * wide, under 2 px per bar module, and zxing never read it (138 frames in a
 * row); at 1.5x it read every time. Corners come back in the input's pixels.
 */
async function decodePoukaz(canvas: HTMLCanvasElement): Promise<BarcodeHit[]> {
  const hits = await decodeCanvas(canvas);
  if (hits.some(isPoukazHit) || Math.max(canvas.width, canvas.height) >= UPSCALE_BELOW) return hits;
  const big = document.createElement("canvas");
  big.width = canvas.width * 2;
  big.height = canvas.height * 2;
  const ctx = big.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, big.width, big.height);
  const more = await decodeCanvas(big);
  if (!more.some(isPoukazHit)) return hits;
  return more.map((h) => ({ ...h, position: h.position.map((p) => ({ x: p.x / 2, y: p.y / 2 })) }));
}

/**
 * Looks for the poukaz code in the video, at low resolution: the stream only
 * aims the shot. It shoots once the code reads twice in a row at the same
 * place, so the phone is holding still and the focus has settled.
 */
async function scanLoop(): Promise<void> {
  scanning = true;
  let frames = 0;
  // The last read and when: a frame that misses the code in between does not start the wait over.
  let prev: { hit: BarcodeHit; at: number } | undefined;
  let reads = 0;
  const started = performance.now();
  $("btn-native").hidden = true;
  while (scanning) {
    const frame = videoFrame(1920);
    if (frame) {
      frames++;
      const hits = await decodePoukaz(frame).catch(() => [] as BarcodeHit[]);
      if (!scanning) return;
      const found = hits.find(isPoukazHit);
      // Too far: the photo's still lens sees more than the stabilized video (two shots had
      // the code at 28-30% of the photo, too soft to decode or read). Only a near code shoots.
      const share = found ? codeShare(found.position, frame.width) : 0;
      const good = share >= MIN_CODE_SHARE ? found : undefined;
      const now = performance.now();
      if (good && prev && now - prev.at <= STEADY_WINDOW_MS && isSteady(prev.hit.position, good.position, frame.width)) {
        // The frame at full stream size is the fallback if the photo misses the code.
        await shoot(videoFrame(3200) ?? undefined, share);
        return;
      }
      if (good) {
        prev = { hit: good, at: now };
        reads++;
      }
      const other = hits.find((h) => h.format !== "Code128");
      $("cam-status").textContent = good
        ? "Kód prečítaný, držte telefón v pokoji..."
        : found
          ? `Priblížte telefón k poukazu (kód má ${Math.round(share * 100)} % šírky, treba ${Math.round(MIN_CODE_SHARE * 100)} %).`
        : other
          ? `Vidím ${other.format}, hľadám čiarový kód poukazu...`
          : hits.length
            ? "Kód nevyzerá ako poukaz, skúste priblížiť."
            : `Hľadám čiarový kód... (${frames}, ${$<HTMLVideoElement>("video").videoWidth}x${$<HTMLVideoElement>("video").videoHeight}${nativeFormats.length ? "" : ", zxing"}${reads ? `, prečítaný ${reads}x` : ""})`;
      // A browser cannot open the camera app by itself: it needs a tap, so this offers a button.
      if (!good && performance.now() - started > NATIVE_HINT_MS && $("btn-native").hidden) {
        $("btn-native").hidden = false;
        $("cam-hint").textContent = "Kód sa nedarí prečítať? Odfoťte poukaz fotoaparátom telefónu, fotka má vyššie rozlíšenie.";
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Takes the photo for OCR. `fallback` is a video frame where the code read:
 * takePhoto lags by up to a second, and a phone lowered too early gives a photo
 * without the form, so the photo must contain the code too.
 */
/**
 * The photo must put at least this many times the video's pixels on the code to be used.
 * Android's still capture sees the whole sensor while the 16:9 video stream the viewfinder
 * shows is a crop of it (more so with stabilization): two shots of a form that filled the
 * viewfinder had the code at 16-21% of the photo's width, 670 and 500 px of 3200, where the
 * video frame had it at about 800 px of 1920. The photo was the worse image.
 */
const MIN_PHOTO_GAIN = 1;

async function shoot(fallback?: HTMLCanvasElement, videoShare?: number): Promise<void> {
  // The button and the auto shot can both fire; one scan at a time shares the OCR worker.
  if (shooting) return;
  shooting = true;
  scanning = false;
  try {
    $("cam-status").textContent = "Držte telefón, fotím...";
    let still = await grabStill();
    // Release the camera, not only pause it: a paused track keeps the camera and any light on.
    stopCamera();
    if (still && fallback && still.source.startsWith("takePhoto")) {
      // A manual shot: the code's size in the frame is not known yet.
      if (videoShare === undefined) {
        const frame = canvasFrom(fallback, fallback.width, fallback.height, 1920);
        const hit = (await decodePoukaz(frame).catch(() => [] as BarcodeHit[])).find(isPoukazHit);
        videoShare = hit ? codeShare(hit.position, frame.width) : 0;
        release(frame);
      }
      const check = canvasFrom(still.canvas, still.canvas.width, still.canvas.height, 2400);
      const hit = (await decodePoukaz(check).catch(() => [] as BarcodeHit[])).find(isPoukazHit);
      const photoShare = hit ? codeShare(hit.position, check.width) : 0;
      release(check);
      const inVideo = Math.round(videoShare * fallback.width);
      const inPhoto = Math.round(photoShare * still.canvas.width);
      state.diag.camera = {
        ...(state.diag.camera as object),
        codeWidth: { video: `${inVideo} px of ${fallback.width} (${Math.round(videoShare * 100)} %)`, photo: `${inPhoto} px of ${still.canvas.width} (${Math.round(photoShare * 100)} %)` },
      };
      const video = `video ${fallback.width}x${fallback.height}`;
      if (!hit) still = { canvas: fallback, source: `${video} (the photo had no code: ${still.source})` };
      else if (inPhoto < inVideo * MIN_PHOTO_GAIN) still = { canvas: fallback, source: `${video} (the photo sees wider: code ${inPhoto} px against ${inVideo} px in the video; ${still.source})` };
      else release(fallback);
    }
    if (!still) {
      showStartError("Nepodarilo sa odfotiť.");
      return;
    }
    await processImage(still.canvas, 0, still.source);
  } finally {
    shooting = false;
  }
}

/** Releases the camera, for the phone's camera app, which cannot share it on an iPhone. */
function stopCamera(): void {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  torchOn = false;
}

// ---------- Pipeline ----------

function showStartError(msg: string): void {
  const e = $("start-error");
  e.textContent = msg;
  e.hidden = false;
  show("start");
}

function addAlert(level: Alert["level"], text: string): void {
  if (!state.alerts.some((a) => a.text === text)) state.alerts.push({ level, text });
  if (level === "block") state.blocked = true;
}

function setField(key: FieldKey, value: string, source: Source, level: Level, crop?: string, note?: string): void {
  state.fields[key] = { value, source, level, crop, note };
}

/** `capture` names the live path that took the image; a file has none. */
async function processImage(input: HTMLCanvasElement, extraRotation: number, capture?: string, retried = false): Promise<void> {
  show("work");
  state.fields = emptyFields();
  state.alerts = [];
  state.blocked = false;
  state.source = input;
  state.capture = capture ?? null;
  const diag: Record<string, unknown> = {
    app: `${__APP_VERSION__} (${__BUILD_TIME__})`,
    ua: navigator.userAgent,
    nativeBarcodeFormats: nativeFormats,
    input: { w: input.width, h: input.height },
    capture: capture ?? "file",
    camera: capture ? state.diag.camera : undefined,
  };
  state.diag = diag;
  const t0 = performance.now();

  try {
    // 1. Barcode on the image as delivered.
    step("barcode");
    setWork("Čítam čiarový kód...");
    let canvas = rotateCanvas(canvasFrom(input, input.width, input.height, 2400), extraRotation);
    // The input's pixels per pixel of `canvas`, for the form crop at full resolution.
    const detail = Math.max(input.width, input.height) / Math.max(canvas.width, canvas.height);
    let hits = await decodePoukaz(canvas);
    // Positions are in the photo as delivered, for calibrating the field template later.
    diag.barcodeHits = hits.map((h) => ({
      engine: h.engine,
      format: h.format,
      text: h.text,
      orientation: h.orientation,
      position: h.position.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    }));
    diag.zxingError = lastZxingError;

    // 2. Rotate so the poukaz barcode is horizontal: it anchors the text direction.
    // First the quarter turn from the barcode corners, then the small tilt
    // measured on the reading zone, so the form rows run level for OCR and the cell crops.
    const pk = hits.find((h) => h.format === "Code128" && parsePoukazBarcode(h.text));
    // A code too soft to decode is still found by its look: the form can then be cut out and
    // read, and the IBAN comes from the digits under the bars (barcodeFromOcrText).
    const located = pk ? undefined : findCode(canvas);
    if (located) diag.barcodeLocated = located.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    let rotation = extraRotation;
    let codeBox: BBox | undefined;
    const codeQuad = pk?.position ?? located;
    if (codeQuad) {
      const a = pk ? orientationFromCorners(pk.position) : 0;
      let quad: Point[] = codeQuad;
      if (a !== 0) {
        quad = quad.map((p) => rotatePoint(p, canvas.width, canvas.height, -a));
        canvas = rotateCanvas(canvas, -a);
        rotation = (rotation - a + 360) % 360;
      }
      const t = performance.now();
      const skew = measureSkew(canvas, quad);
      diag.skew = { degrees: skew, ms: Math.round(performance.now() - t) };
      const tilt = skew !== undefined && Math.abs(skew) >= MIN_SKEW ? skew : 0;
      // Turn the input at its full size, so the crop keeps every pixel the photo has.
      // Each step frees the one before: on a phone the copies ran out of canvas memory.
      let full = canvasFrom(input, input.width, input.height, Infinity);
      full = swap(full, rotateCanvas(full, extraRotation));
      full = swap(full, rotateCanvas(full, -a));
      quad = quad.map((p) => ({ x: p.x * detail, y: p.y * detail }));
      if (tilt) {
        quad = quad.map((p) => rotatePoint(p, full.width, full.height, -tilt));
        full = swap(full, rotateCanvas(full, -tilt));
      }
      const form = cropToForm(full, quad);
      release(full);
      diag.formCrop = form.note;
      codeBox = form.code;
      release(canvas);
      canvas = form.canvas;
    }
    // Only the quarter turn: a reread measures the tilt again.
    state.rotation = rotation;
    diag.rotation = rotation;

    let barcode: PoukazBarcode | null = pk ? parsePoukazBarcode(pk.text) : null;
    handleOtherCodes(hits);

    // 3. OCR of the printed fields.
    step("ocr");
    setWork("Načítavam OCR (prvýkrát to chvíľu trvá)...", 0);
    setOcrProgress((status, p) => {
      if (status.startsWith("loading") || status.startsWith("initializ")) setWork(`OCR: ${status}...`, p);
      else if (status === "recognizing text") setWork("Čítam vytlačený text...", p);
    });
    // Even out the light first: the cell pass reads the color image too.
    const flat = flattenCanvas(canvas);
    const ocrCanvas = prepareForOcr(flat);
    // A blank image is a phone out of canvas memory (the barcode, read from a smaller copy,
    // still gave the IBAN, and nothing else filled). Read it again from a smaller copy.
    if (isBlank(ocrCanvas) || isBlank(flat)) {
      const smaller = Math.round(Math.max(input.width, input.height) * 0.6);
      release(flat, ocrCanvas, canvas);
      if (!retried && smaller >= 1600) {
        await processImage(canvasFrom(input, input.width, input.height, smaller), extraRotation, `${capture ?? "file"}; blank at ${input.width}x${input.height}, read again at ${smaller} px`, true);
        // Saving and "Prečítať znova" take the photo as taken; a reread retries smaller again.
        state.source = input;
        return;
      }
      throw new Error("Obrázok sa nepodarilo spracovať (málo pamäte). Skúste znova alebo vyberte fotku z galérie.");
    }
    const page = await ocrPage(ocrCanvas);
    diag.ocrMs = page.ms;
    diag.ocrText = page.text;
    diag.ocrLines = page.lines;
    const ex = extractFields(page.lines, codeBox);
    diag.extracted = summarize(ex);

    // Clear text under the bars, when the image decode missed the barcode.
    if (!barcode) {
      for (const d of ex.barcodeDigits) {
        const p = parsePoukazBarcode(d);
        if (p && (p.ibanValid || p.mod11 === "ok")) {
          barcode = p;
          diag.barcodeFromOcrText = d;
          break;
        }
      }
    }

    // 4. Digit-only second pass for empty symbol and amount fields.
    step("digits");
    setWork("Dočítavam číselné polia...");
    await readFixedFields(flat, ex, diag);
    await secondPass(ocrCanvas, flat, ex, diag);
    await voteName(ocrCanvas, ex, diag);

    diag.barcode = barcode;
    merge(barcode, ex, ocrCanvas);
    diag.totalMs = Math.round(performance.now() - t0);

    setPhoto(canvasFrom(canvas, canvas.width, canvas.height, 1200));

    renderResult();
    // The field crops are data URLs by now; the big copies are not needed.
    release(flat, ocrCanvas);
    show("result");
  } catch (e) {
    console.error(e);
    diag.error = String(e instanceof Error ? e.stack || e.message : e);
    addAlert("warn", `Spracovanie zlyhalo: ${e instanceof Error ? e.message : String(e)}. Údaje zadajte ručne.`);
    setPhoto(canvasFrom(input, input.width, input.height, 1200));
    renderResult();
    show("result");
  }
}

function drawPhoto(): void {
  if (!state.shown) return;
  const c = rotateCanvas(state.shown, state.turn);
  const photo = $<HTMLCanvasElement>("photo");
  photo.width = c.width;
  photo.height = c.height;
  photo.getContext("2d")!.drawImage(c, 0, 0);
}

function setPhoto(c: HTMLCanvasElement): void {
  state.shown = c;
  state.turn = 0;
  drawPhoto();
}

function turnPhoto(deg: number): void {
  state.turn = (state.turn + deg + 360) % 360;
  drawPhoto();
}

const PREDICTED_NOTE = "Popis poľa sa neprečítal, hodnota je z jeho miesta na tlačive. Overte ju.";

function summarize(ex: ExtractResult): Record<string, string | undefined> {
  return {
    iban: ex.iban?.value,
    amount: ex.amount?.value,
    vs: ex.vs?.value,
    ss: ex.ss?.value,
    ks: ex.ks?.value,
    name: ex.name?.value,
    message: ex.message?.value,
    amountWords: ex.amountWords ? `${ex.amountWords.text} -> ${ex.amountWords.euros}` : undefined,
    layout: !ex.layout ? "no fit" : ex.layout.anchors ? `${ex.layout.anchors} labels, error ${ex.layout.residual} px, added: ${ex.layout.added.join(", ") || "none"}` : "placed by the barcode alone",
  };
}

function handleOtherCodes(hits: BarcodeHit[]): void {
  for (const h of hits) {
    if (h.format === "DataMatrix") {
      addAlert(
        "block",
        "Na doklade je DataMatrix kód: ide asi o SKPAY ePOUKAZ alebo Poštový poukaz ekonomický. Ich IBAN je zberný účet, bankový prevod by sa nepriradil. Zaplaťte podľa pokynov na doklade.",
      );
    } else if (h.format === "QRCode") {
      try {
        const model = decodeBySquare(h.text);
        const p = model.payments[0];
        if (p) {
          const iban = p.bankAccounts[0]?.iban ?? "";
          setField("iban", iban, "qr", "high");
          if (p.amount) setField("amount", formatAmount(Math.round(p.amount * 100)).replace(".", ","), "qr", "high");
          if (p.variableSymbol) setField("vs", p.variableSymbol, "qr", "high");
          if (p.specificSymbol) setField("ss", p.specificSymbol, "qr", "high");
          if (p.constantSymbol) setField("ks", p.constantSymbol, "qr", "high");
          if (p.paymentNote) setField("message", p.paymentNote, "qr", "high");
          if (p.beneficiary?.name) setField("name", p.beneficiary.name, "qr", "high");
          addAlert("info", "Nájdený PAY by square QR kód, údaje sú z neho.");
          (state.diag as Record<string, unknown>).bysquare = model;
        }
      } catch {
        addAlert("info", "Nájdený QR kód, ale nie je to PAY by square.");
      }
    }
  }
}

/**
 * The name is printed twice, on the stub and in the middle ADRESÁT block. Each
 * copy is read by the page OCR and again from its own crop, and the letters
 * are put to a vote (vote.ts). One photo read "SF OJENÁ" on the stub and
 * "ŠSPOJENÁ" in the middle; neither alone was right.
 */
async function voteName(ocrCanvas: HTMLCanvasElement, ex: ExtractResult, diag: Record<string, unknown>): Promise<void> {
  const copies = (ex.nameCopies ?? []).filter((c) => c.bbox);
  if (!copies.length) return;
  const readings: Reading[] = [];
  for (const c of copies) {
    readings.push({ text: c.value, confidence: c.confidence });
    readings.push(await ocrLine(ocrCanvas, c.bbox!));
  }
  const voted = consensus(readings);
  diag.nameVote = { readings: readings.map((r) => `${r.text} (${Math.round(r.confidence)})`), result: voted?.text, used: voted?.used };
  // The page's own reading stands when the others were of other lines.
  if (voted && voted.used >= 2) ex.name = { ...(ex.name ?? copies[0]), value: voted.text.replace(/[\s,;.]+$/, "") };
}

/** The digit pass under the SUMA label, when there are no amount words to check it against. */
const MIN_AMOUNT_CONFIDENCE = 60;

function fitsPattern(text: string, pattern: string): boolean {
  return text.length === pattern.length && [...pattern].every((p, i) => p === "?" || p === text[i]);
}

function union(boxes: BBox[]): BBox {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/**
 * Reads the fields from where the form prints them (layout.ts FIELDS), mapped
 * by the template fit, instead of searching next to their labels. Runs only with
 * a fit; what it cannot read, the label search and secondPass still try.
 */
async function readFixedFields(colorCanvas: HTMLCanvasElement, ex: ExtractResult, diag: Record<string, unknown>): Promise<void> {
  const fit = ex.fit;
  if (!fit) return;
  const tries: Record<string, unknown> = {};
  // Placed by the barcode alone, the grids can sit a row off: on one soft shot the SS grid
  // read the reference number below it. SS is left out then, VS and KS are flagged.
  const rough = !ex.layout?.anchors;

  // VS from its boxes. The stub's copy, when OCR read it, is the second opinion.
  const vsCells = gridCells(fit, FIELDS.vs);
  const vs = await ocrGridDigits(colorCanvas, vsCells, undefined, 2);
  tries.vs = vs.attempts;
  ex.patterns = {};
  if (!vs.text && vs.pattern) ex.patterns.vs = vs.pattern;
  if (vs.text) {
    const stub = ex.vs?.value;
    ex.vs = { value: vs.text, confidence: stub && stub !== vs.text ? Math.min(vs.confidence, 60) : vs.confidence, bbox: union(vsCells), other: stub && stub !== vs.text ? stub : undefined, predicted: rough };
  }

  const ksCells = gridCells(fit, FIELDS.ks);
  const ks = await ocrGridDigits(colorCanvas, ksCells, isKnownKsClass, 4);
  tries.ks = ks.attempts;
  if (!ks.text && ks.pattern) ex.patterns.ks = ks.pattern;
  if (ks.text) ex.ks = { value: ks.text, confidence: ks.confidence, bbox: union(ksCells), predicted: rough };
  else {
    const value = ks.partials.map(completeKs).find(Boolean);
    if (value) ex.ks = { value, confidence: 40, bbox: union(ksCells), filled: true };
  }

  if (!ex.ss?.value && !rough) {
    const ssCells = gridCells(fit, FIELDS.ss);
    const ss = await ocrGridDigits(colorCanvas, ssCells, undefined, 2);
    tries.ss = ss.attempts;
    if (!ss.text && ss.pattern) ex.patterns.ss = ss.pattern;
    if (ss.text) ex.ss = { value: ss.text, confidence: ss.confidence, bbox: union(ssCells) };
  }

  // The message, two rows of boxes. A word runs on from the end of the first row
  // ("RICH" + "ARD"), so the rows join without a space; an empty box is one.
  const rows = [];
  for (const g of FIELDS.message) rows.push(await ocrGridText(colorCanvas, gridCells(fit, g)));
  tries.message = rows.map((r) => `${r.boxes} (${r.shapes})`);
  const message = rows.map((r) => r.text).join("").replace(/\s+/g, " ").trim();
  if ((message.match(/\p{L}/gu) ?? []).length >= 2) {
    const area = union(FIELDS.message.flatMap((g) => gridCells(fit, g)));
    ex.message = { value: message, confidence: Math.min(...rows.map((r) => r.confidence)), bbox: area };
  }

  diag.fixedFields = tries;
}

async function secondPass(
  ocrCanvas: HTMLCanvasElement,
  colorCanvas: HTMLCanvasElement,
  ex: ExtractResult,
  diag: Record<string, unknown>,
): Promise<void> {
  const tries: Record<string, unknown> = {};
  for (const key of ["vs", "ss", "ks", "amount"] as const) {
    const f = ex[key];
    if (key === "amount") {
      const boxed = await readBoxedAmount(colorCanvas, ex);
      if (boxed) tries.amountBoxed = boxed.tries;
      if (boxed?.value) {
        ex.amount = boxed.value;
        continue;
      }
    }
    if (!f || f.value || !f.labelBox) continue;
    const b = f.labelBox;
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    if (key === "amount") {
      const rect: BBox = { x0: b.x0 - w * 0.15, y0: b.y1, x1: b.x1 + w * 0.6, y1: b.y1 + h * 3 };
      const r = await ocrDigits(ocrCanvas, rect, true);
      tries[key] = r;
      // Seen: "1" at confidence 17 for 37,50 in words. The words decide; without them, the confidence.
      const cents = parseAmount(r.text.replace(/^=/, ""));
      const words = ex.amountWords?.euros;
      const agrees = words === undefined ? r.confidence >= MIN_AMOUNT_CONFIDENCE : cents !== undefined && Math.floor(cents / 100) === words;
      if (cents && agrees) ex.amount = { value: r.text.replace(/^=/, ""), confidence: r.confidence * 0.8, bbox: rect, labelBox: b };
      continue;
    }
    // The crop starts inside the label on purpose: the label then touches the
    // crop edge and segmentCells drops it. VS and SS have ten cells.
    const max = key === "ks" ? 4 : 10;
    const rect: BBox = { x0: b.x0 - w * 0.15, y0: b.y1 - h * 0.6, x1: b.x1 + w * (key === "ks" ? 0.6 : 1.4), y1: b.y1 + h * 3 };
    // The VS boxes end where the KS boxes start, under the KS label. Past it the crop took
    // KS's first 0 as a seventh VS digit (1126130 for 112613).
    const ks = ex.ks?.labelBox;
    if (key !== "ks" && ks && ks.x0 > b.x1 && Math.abs((ks.y0 + ks.y1) / 2 - (b.y0 + b.y1) / 2) <= h * 1.5) {
      rect.x1 = Math.min(rect.x1, ks.x0 - h * 0.1);
    }
    // A single isolated shape is a reading that lost the rest (seen: VS "1" for 112606).
    const r = await ocrBoxedDigits(colorCanvas, rect, max, key === "ks" ? isKnownKsClass : undefined, key === "ks" ? 4 : 2);
    tries[key] = { ...r, rect: roundBox(rect) };
    // The boxes showed part of it ("112?13"): a reading of another length or with other
    // digits is of something else (seen: 1126130, KS's first 0 taken as a VS digit).
    const pattern = ex.patterns?.[key];
    if (r.text && pattern && !fitsPattern(r.text, pattern)) {
      tries[key] = { ...r, rect: roundBox(rect), rejected: `does not fit ${pattern}` };
      continue;
    }
    if (r.text) {
      ex[key] = { value: r.text, confidence: r.confidence, bbox: rect, labelBox: b, predicted: f.predicted };
    } else if (key === "ks") {
      const value = r.partials.map(completeKs).find(Boolean);
      if (value) ex.ks = { value, confidence: 40, bbox: rect, labelBox: b, filled: true, predicted: f.predicted };
    }
  }
  diag.secondPass = tries;
}

/**
 * Reads the boxed amount at the top of the form when the digits are missing or
 * contradict the words. With the words known, a reading counts only if it equals them.
 */
async function readBoxedAmount(
  colorCanvas: HTMLCanvasElement,
  ex: ExtractResult,
): Promise<{ value?: Extracted; tries: unknown } | undefined> {
  const cols = ex.amountColumns;
  if (!cols) return undefined;
  const words = ex.amountWords?.euros;
  const current = ex.amount?.value ? parseAmount(ex.amount.value) : undefined;
  if (current !== undefined && (words === undefined || Math.floor(current / 100) === words)) return undefined;

  const { eur, cent } = cols;
  const h = eur.y1 - eur.y0;
  const top = eur.y1 - h * 0.6;
  const bottom = eur.y1 + h * 4;
  const eurW = eur.x1 - eur.x0;
  const centW = cent.x1 - cent.x0;
  const eurRect: BBox = { x0: eur.x0 - eurW * 6, y0: top, x1: eur.x1 + eurW * 0.4, y1: bottom };
  const centRect: BBox = { x0: cent.x0 - centW * 1.2, y0: top, x1: cent.x1 + centW * 0.4, y1: bottom };
  const euros = await ocrBoxedDigits(colorCanvas, eurRect, 7, words === undefined ? undefined : (t) => Number(t) === words);
  const cents = await ocrBoxedDigits(colorCanvas, centRect, 2, undefined, 2);
  const tries = { euros: { ...euros, rect: roundBox(eurRect) }, cents: { ...cents, rect: roundBox(centRect) } };
  const bbox: BBox = { x0: eurRect.x0, y0: top, x1: centRect.x1, y1: bottom };
  if (cents.text.length !== 2) {
    // The words with the cents OCR read under a "cent" label elsewhere, as the stub's.
    const stub = ex.centsBelowLabel;
    if (current !== undefined || words === undefined || !stub) return { tries };
    const value = { value: `${words},${stub.value}`, confidence: Math.min(ex.amountWords!.confidence, stub.confidence), bbox: stub.bbox, filled: true };
    return { tries: { ...tries, stubCents: stub.value }, value };
  }
  if (words !== undefined && Number(euros.text) !== words) {
    // Unreadable euros with known words: the words give the euros. Never replace digits that exist.
    if (current !== undefined) return { tries };
    return { tries, value: { value: `${words},${cents.text}`, confidence: Math.min(ex.amountWords!.confidence, cents.confidence), bbox, filled: true } };
  }
  if (!euros.text) return { tries };
  return { tries, value: { value: `${Number(euros.text)},${cents.text}`, confidence: Math.min(euros.confidence, cents.confidence), bbox } };
}

function roundBox(b: BBox): BBox {
  return { x0: Math.round(b.x0), y0: Math.round(b.y0), x1: Math.round(b.x1), y1: Math.round(b.y1) };
}

function ocrLevel(conf: number): Level {
  return conf >= 85 ? "medium" : "low";
}

function merge(barcode: PoukazBarcode | null, ex: ExtractResult, ocrCanvas: HTMLCanvasElement): void {
  const crop = (b?: BBox) => cropDataUrl(ocrCanvas, b);
  const q = state.fields;

  // IBAN: QR > barcode (mod-97 valid) > OCR.
  if (q.iban.source !== "qr") {
    if (barcode?.iban && barcode.ibanValid) {
      setField("iban", barcode.iban, "barcode", "high");
      if (ex.iban && ex.iban.value !== barcode.iban) {
        addAlert("warn", `Vytlačený IBAN (${formatIban(ex.iban.value)}) sa líši od čiarového kódu. Overte ho.`);
      }
    } else if (ex.iban) {
      setField("iban", ex.iban.value, "ocr", "medium", crop(ex.iban.bbox));
    }
  }
  if (barcode) {
    if (barcode.mod11 === "fail") {
      addAlert("info", "Kontrolná číslica čiarového kódu (mod 11) nesedí. IBAN prešiel kontrolou mod 97, ostatné údaje z kódu overte.");
    }
    const adv = productAdvice(barcode.product);
    if (adv) addAlert(adv.level, adv.text);
    for (const n of barcode.notes) addAlert("info", n);
  } else if (q.iban.source !== "qr") {
    addAlert("info", "Čiarový kód poukazu sa nenašiel. Všetky údaje sú z OCR, skontrolujte ich.");
  }

  // Amount: the Post credits the printed digits, so printed wins on conflict.
  if (q.amount.source !== "qr") {
    const printed = ex.amount?.value ? parseAmount(ex.amount.value) : undefined;
    const coded = barcode?.amountCents;
    if (printed) {
      setField("amount", formatAmount(printed).replace(".", ","), "ocr", ocrLevel(ex.amount!.confidence), crop(ex.amount!.bbox));
      if (coded && coded !== printed) {
        q.amount.note = `Čiarový kód hovorí ${formatAmount(coded).replace(".", ",")} EUR; platí vytlačená suma.`;
        addAlert("warn", "Suma v čiarovom kóde sa líši od vytlačenej. Pošta pripisuje vytlačenú sumu, overte ju.");
      } else if (coded) {
        q.amount.level = "high";
      }
    } else if (coded) {
      setField("amount", formatAmount(coded).replace(".", ","), "barcode", "high");
    }
    checkAmountWords(ex);
  }

  // Symbols: barcode when non-zero, else OCR; flag disagreement.
  const coded: Partial<Record<"vs" | "ss" | "ks", string | undefined>> = {
    vs: barcode?.vs,
    ss: barcode?.ss,
    ks: barcode?.ks ? barcode.ks.padStart(4, "0") : undefined,
  };
  for (const key of ["vs", "ss", "ks"] as const) {
    if (q[key].source === "qr") continue;
    const o = ex[key];
    const c = coded[key];
    if (c) {
      setField(key, c, "barcode", "high");
      if (o?.value && o.value.replace(/^0+/, "") !== c.replace(/^0+/, "")) {
        q[key].note = `OCR prečítalo ${o.value}.`;
        addAlert("warn", `${key.toUpperCase()} z čiarového kódu (${c}) a z OCR (${o.value}) sa líšia.`);
      } else if (o?.value) {
        q[key].level = "high";
      }
    } else if (o?.value) {
      const note = o.other ? `Ľavá časť poukazu má ${o.other}, overte.` : o.predicted ? PREDICTED_NOTE : undefined;
      setField(key, o.value, "ocr", o.other || o.predicted ? "low" : ocrLevel(o.confidence), crop(o.bbox), note);
    } else if (o?.labelBox) {
      q[key].crop = crop({ x0: o.labelBox.x0, y0: o.labelBox.y0, x1: o.labelBox.x1 + (o.labelBox.x1 - o.labelBox.x0) * 0.6, y1: o.labelBox.y1 + (o.labelBox.y1 - o.labelBox.y0) * 3 });
    }
  }

  if (q.ks.source === "ocr" && ex.ks?.filled) {
    q.ks.note = "Jednu číslicu doplnil zoznam symbolov, overte ju.";
  } else if (q.ks.source === "ocr" && !isKnownKsClass(q.ks.value)) {
    q.ks.level = "low";
    q.ks.note = "Tento KS nie je v zozname známych symbolov, overte ho.";
  }

  for (const key of ["name", "message"] as const) {
    if (q[key].source === "qr") continue;
    const o = ex[key];
    if (o?.value) setField(key, o.value, "ocr", "low", crop(o.bbox), o.predicted ? PREDICTED_NOTE : undefined);
  }
}

/** The words hold only the euros, so they confirm or contradict the amount but never set it. */
function checkAmountWords(ex: ExtractResult): void {
  const words = ex.amountWords?.euros;
  if (words === undefined) return;
  const q = state.fields.amount;
  const cents = parseAmount(q.value);
  if (ex.amount?.filled) {
    q.level = "low";
    q.note = "Eurá sú zo sumy slovom, overte ich.";
  } else if (cents === undefined) {
    q.note = `Slovom: ${words} EUR. Doplňte sumu s centami.`;
  } else if (Math.floor(cents / 100) === words) {
    q.level = "high";
  } else {
    q.level = "low";
    q.note = `Slovom je napísané ${words} EUR.`;
    addAlert("warn", `Suma číslom a suma slovom (${words} EUR) sa líšia. Overte ju.`);
  }
}

// ---------- Result screen ----------

const SOURCE_LABEL: Record<Source, string> = {
  barcode: "z kódu",
  qr: "z QR",
  ocr: "OCR",
  manual: "ručne",
  none: "chýba",
};

function input(key: FieldKey): HTMLInputElement {
  return $<HTMLInputElement>(`f-${key}`);
}

function renderResult(): void {
  const alerts = $("alerts");
  alerts.replaceChildren(
    ...state.alerts.map((a) => {
      const d = document.createElement("div");
      d.className = `alert ${a.level}`;
      d.textContent = a.text;
      return d;
    }),
  );
  for (const [key, f] of Object.entries(state.fields) as [FieldKey, FieldState][]) {
    const el = input(key);
    if (key === "iban") el.value = f.value ? formatIban(f.value) : "";
    else if (key === "due") el.value = f.value;
    else el.value = f.value;
    const box = el.closest(".field") as HTMLElement;
    const img = box.querySelector<HTMLImageElement>("img.crop");
    if (img) {
      img.hidden = !f.crop;
      if (f.crop) img.src = f.crop;
    }
  }
  $("photo-box").toggleAttribute("open", false);
  // A live shot that missed fields: the phone's camera app gives full resolution.
  const missed = !state.fields.amount.value || !state.fields.vs.value;
  $("retry-photo").hidden = !(state.capture && missed);
  updateFieldUi();
  updateOutput();
}

function validate(key: FieldKey, v: string): { ok: boolean; hint: string } {
  switch (key) {
    case "iban": {
      if (!v) return { ok: false, hint: "Povinné." };
      if (!isValidIban(v)) return { ok: false, hint: "Neplatný IBAN (kontrola mod 97)." };
      const parts = splitSkIban(v);
      const legacy = parts && (!isValidLegacyPart(parts.predcislie) || !isValidLegacyPart(parts.zaklad));
      const bank = bankName(v);
      return {
        ok: true,
        hint: [bank ? `Banka: ${bank}` : parts ? `Kód banky ${parts.bank}` : "", legacy ? "Číslo účtu neprešlo kontrolou mod 11, overte." : ""]
          .filter(Boolean)
          .join(". "),
      };
    }
    case "amount": {
      if (!v) return { ok: true, hint: "Bez sumy ju zadáte v banke." };
      const c = parseAmount(v);
      if (!c) return { ok: false, hint: "Neplatná suma." };
      if (c > 1_500_000) return { ok: true, hint: "Viac ako 15 000 EUR, limit poukazu. Overte." };
      return { ok: true, hint: "" };
    }
    case "vs":
    case "ss":
      return /^\d{0,10}$/.test(v) ? { ok: true, hint: "" } : { ok: false, hint: "Len číslice, max 10." };
    case "ks":
      if (!v) return { ok: true, hint: "" };
      return /^\d{4}$/.test(v) ? { ok: true, hint: "" } : /^\d{1,3}$/.test(v) ? { ok: true, hint: "KS má zvyčajne 4 číslice." } : { ok: false, hint: "Len číslice, max 4." };
    case "name":
      return v.trim() ? { ok: true, hint: "" } : { ok: false, hint: "Povinné pre payme. Odpíšte z poukazu (adresát)." };
    default:
      return { ok: true, hint: "" };
  }
}

function updateFieldUi(): void {
  for (const [key, f] of Object.entries(state.fields) as [FieldKey, FieldState][]) {
    const el = input(key);
    const box = el.closest(".field") as HTMLElement;
    const badge = box.querySelector(".badge") as HTMLElement;
    const hint = box.querySelector(".hint") as HTMLElement;
    const v = key === "iban" ? normalizeIban(el.value) : el.value.trim();
    const r = validate(key, v);
    if (key === "due") {
      badge.hidden = true;
    } else {
      badge.hidden = false;
      badge.textContent = v ? SOURCE_LABEL[f.source === "none" ? "manual" : f.source] : SOURCE_LABEL.none;
      badge.className = `badge ${v ? f.source : "none"} ${v ? f.level ?? "" : ""}`;
    }
    box.classList.toggle("invalid", !r.ok);
    box.classList.toggle("check", f.source === "ocr");
    hint.textContent = [r.hint, f.note].filter(Boolean).join(" ");
  }
}

let qrSeq = 0;

function currentPayment() {
  const val = (k: FieldKey) => input(k).value.trim();
  const due = val("due");
  return {
    iban: normalizeIban(val("iban")),
    amountCents: parseAmount(val("amount")),
    vs: val("vs") || undefined,
    ss: val("ss") || undefined,
    ks: val("ks") || undefined,
    message: val("message") || undefined,
    creditorName: val("name"),
    dueDate: due ? due.replace(/-/g, "") : undefined,
  };
}

function updateOutput(): void {
  const missing = $("out-missing");
  const ready = $("out-ready");
  const p = currentPayment();
  const problems: string[] = [];
  if (state.blocked) problems.push("Platbu prevodom pre tento doklad nevytváram (pozri upozornenie hore).");
  if (!isValidIban(p.iban)) problems.push("Doplňte platný IBAN.");
  if (!p.creditorName) problems.push("Doplňte meno príjemcu.");
  for (const k of ["amount", "vs", "ss", "ks"] as FieldKey[]) {
    if (!validate(k, input(k).value.trim()).ok) problems.push(`Opravte pole ${k.toUpperCase()}.`);
  }
  if (problems.length) {
    missing.textContent = problems.join(" ");
    missing.hidden = false;
    ready.hidden = true;
    state.diag.output = { problems };
    renderDiag();
    return;
  }
  try {
    const url = buildPaymeLink(p);
    const link = $<HTMLAnchorElement>("payme-link");
    link.href = url;
    $("payme-url").textContent = url;
    const bysq = buildBySquare(p);
    const seq = ++qrSeq;
    void QRCode.toCanvas($<HTMLCanvasElement>("qr"), bysq, { errorCorrectionLevel: "M", margin: 2, width: 280 }).then(() => {
      if (seq !== qrSeq) return;
    });
    missing.hidden = true;
    ready.hidden = false;
    state.diag.output = { payme: url, bysquare: bysq };
  } catch (e) {
    missing.textContent = e instanceof PaymeError ? e.message : `Chyba: ${String(e)}`;
    missing.hidden = false;
    ready.hidden = true;
    state.diag.output = { error: String(e) };
  }
  renderDiag();
}

function renderDiag(): void {
  $("diag").textContent = JSON.stringify(state.diag, null, 2);
}

async function copy(text: string, btn: HTMLElement): Promise<void> {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Skopírované";
  } catch {
    btn.textContent = "Nepodarilo sa";
  }
  setTimeout(() => (btn.textContent = old), 1500);
}

// ---------- Share and save ----------

/** File name part from the VS, or a date when the form has none. */
function fileStem(): string {
  const vs = input("vs").value.trim();
  return vs ? `poukaz-vs${vs}` : `poukaz-${new Date().toISOString().slice(0, 10)}`;
}

async function shareLink(btn: HTMLElement): Promise<void> {
  const url = $("payme-url").textContent ?? "";
  if (!url) return;
  const p = currentPayment();
  const amount = p.amountCents ? `${formatAmount(p.amountCents).replace(".", ",")} EUR` : "";
  try {
    await navigator.share({ title: "Platba poukazu", text: [p.creditorName, amount].filter(Boolean).join(", "), url });
  } catch (e) {
    // The person closed the share sheet. Anything else: offer the copy button instead.
    if (!(e instanceof DOMException && e.name === "AbortError")) await copy(url, btn);
  }
}

/**
 * The QR as a PNG, larger than on screen, with the payee and amount under it,
 * so the image still says what it pays when it is opened later.
 */
async function qrImage(): Promise<Blob> {
  const p = currentPayment();
  const size = 640;
  const qr = document.createElement("canvas");
  await QRCode.toCanvas(qr, buildBySquare(p), { errorCorrectionLevel: "M", margin: 4, width: size });
  const lines = [
    p.creditorName,
    [p.amountCents ? `${formatAmount(p.amountCents).replace(".", ",")} EUR` : "", p.vs ? `VS ${p.vs}` : "", p.ks ? `KS ${p.ks}` : ""]
      .filter(Boolean)
      .join("   "),
  ].filter(Boolean);
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size + 24 + lines.length * 34;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(qr, 0, 0);
  ctx.fillStyle = "#1a1d1a";
  ctx.textAlign = "center";
  ctx.font = '500 24px "IBM Plex Sans Condensed", sans-serif';
  lines.forEach((t, i) => ctx.fillText(t, size / 2, size + 8 + (i + 1) * 30, size - 32));
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"));
}

/** On a phone the share sheet has "Save image" and the photo apps. A desktop gets a download. */
async function saveFile(blob: Blob, name: string, title: string): Promise<void> {
  const file = new File([blob], name, { type: blob.type });
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function saveQr(btn: HTMLElement): Promise<void> {
  const old = btn.textContent;
  try {
    await saveFile(await qrImage(), `${fileStem()}.png`, "PAY by square");
  } catch {
    btn.textContent = "Nepodarilo sa";
    setTimeout(() => (btn.textContent = old), 1500);
  }
}

/**
 * The image the scan read, as delivered: the live shot, or the file. With it a
 * form that read badly can be read again elsewhere, or sent with the diagnostics.
 */
async function savePhoto(btn: HTMLElement): Promise<void> {
  const old = btn.textContent;
  try {
    const src = state.source;
    if (!src) throw new Error("no photo");
    const blob = await new Promise<Blob>((ok, fail) => src.toBlob((b) => (b ? ok(b) : fail(new Error("toBlob"))), "image/jpeg", 0.92));
    await saveFile(blob, `${fileStem()}-foto.jpg`, "Fotka poukazu");
  } catch {
    btn.textContent = "Nepodarilo sa";
    setTimeout(() => (btn.textContent = old), 1500);
  }
}

// ---------- Offline ----------

/** The service worker exists only in the build (vite.config.ts writes it). */
/**
 * Registers the service worker and offers a new version as soon as it is
 * installed. An installed app reopened from the recent apps list only resumes:
 * it never reloads, so the new worker would wait for good. So the app checks
 * for an update whenever it comes to the front, and the bar's button switches.
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  // The first install also changes the controller (clients.claim); that is no reason to reload.
  const hadController = !!sw.controller;
  let reloading = false;
  sw.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const reg = await sw.register("sw.js", { updateViaCache: "none" });
      const offer = () => {
        if (reg.waiting && sw.controller) $("update-bar").hidden = false;
      };
      offer();
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed") offer();
        });
      });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void reg.update().catch(() => {});
      });
      $("btn-update").addEventListener("click", () => {
        if (reg.waiting) reg.waiting.postMessage("skip-waiting");
        else location.reload();
      });
    } catch (e) {
      console.warn("service worker", e);
    }
  });
}

// ---------- Theme ----------

type Theme = "auto" | "light" | "dark";
const THEME_KEY = "pay-theme";
const BAR_COLOR = { light: "#f3eee1", dark: "#121814" };

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

function applyTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
  // The two theme-color metas carry media queries; a forced theme sets both.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const forMedia = m.media.includes("dark") ? "dark" : "light";
    m.content = BAR_COLOR[t === "auto" ? forMedia : t];
  });
  document.querySelectorAll<HTMLButtonElement>("[data-theme-set]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.themeSet === t));
  });
}

function initTheme(): void {
  applyTheme(readTheme());
  document.querySelectorAll<HTMLButtonElement>("[data-theme-set]").forEach((b) => {
    b.addEventListener("click", () => {
      const t = b.dataset.themeSet as Theme;
      try {
        if (t === "auto") localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, t);
      } catch {
        // storage blocked: the choice still holds for this page view
      }
      applyTheme(t);
    });
  });
}

// ---------- Wiring ----------

function wire(): void {
  initTheme();
  $("footer").textContent = `v${__APP_VERSION__} | ${__BUILD_TIME__}`;
  $("fields").addEventListener("submit", (e) => e.preventDefault());

  // On a phone the camera app is the way to a sharp photo (see CLAUDE.md, "Camera"): it is
  // the primary button, and the live view with its automatic shot a link. Without
  // ImageCapture the live view would have only video frames, so the link is not offered.
  if (isPhone) {
    const photo = $("btn-photo");
    photo.className = "btn primary";
    photo.textContent = "Odfotiť poukaz";
    const live = $("btn-camera");
    live.className = "textlink";
    live.textContent = "Živý náhľad s automatickou spúšťou";
    live.hidden = !canTakePhoto;
    $("actions-start").append(live);
  }
  $("btn-camera").addEventListener("click", async () => {
    $("start-error").hidden = true;
    // Before any await: fullscreen needs the tap.
    const landscape = enterLandscape();
    try {
      show("camera");
      $("cam-status").textContent = "Spúšťam kameru...";
      $("cam-hint").textContent = DEFAULT_CAM_HINT;
      // The stream follows the screen; start it after the turn, so it opens wide.
      const turned = await landscape;
      await startCamera();
      state.diag.camera = { ...(state.diag.camera as object), orientation: turned };
      warmUpBarcode();
      void getOcrWorker().catch(() => {});
      void scanLoop();
    } catch (e) {
      showStartError(e instanceof Error ? e.message : String(e));
    }
  });

  $("btn-shoot").addEventListener("click", () => void shoot(videoFrame(3200) ?? undefined));
  // Open the camera app inside the tap; the live stream must let go of the camera first.
  const openCameraApp = () => {
    stopCamera();
    show("start");
    $<HTMLInputElement>("file-input").click();
  };
  $("btn-native").addEventListener("click", openCameraApp);
  $("btn-retry-photo").addEventListener("click", openCameraApp);
  $("btn-torch").addEventListener("click", () => void setTorch(!torchOn));
  $("btn-cam-cancel").addEventListener("click", () => {
    stopCamera();
    show("start");
  });

  const onFile = async (ev: Event) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    (ev.target as HTMLInputElement).value = "";
    if (!file) return;
    $("start-error").hidden = true;
    try {
      show("work");
      step("load");
      setWork("Načítavam obrázok...");
      void getOcrWorker().catch(() => {});
      // Some engines reject the imageOrientation option; EXIF orientation is
      // then applied by default in current browsers anyway.
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
      const c = canvasFrom(bmp, bmp.width, bmp.height, 3200);
      bmp.close();
      await processImage(c, 0);
    } catch (e) {
      showStartError(`Obrázok sa nepodarilo načítať: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  $<HTMLInputElement>("file-input").addEventListener("change", (ev) => void onFile(ev));
  $<HTMLInputElement>("gallery-input").addEventListener("change", (ev) => void onFile(ev));

  $("btn-manual").addEventListener("click", () => {
    state.capture = null;
    state.fields = emptyFields();
    state.alerts = [];
    state.blocked = false;
    state.diag = { app: `${__APP_VERSION__} (${__BUILD_TIME__})`, manual: true };
    renderResult();
    show("result");
  });

  $("btn-turn-left").addEventListener("click", () => turnPhoto(-90));
  $("btn-turn-right").addEventListener("click", () => turnPhoto(90));
  $("btn-reprocess").addEventListener("click", () => {
    if (state.source) void processImage(state.source, (state.rotation + state.turn) % 360, state.capture ?? undefined);
  });

  for (const key of ["iban", "amount", "vs", "ss", "ks", "name", "message", "due"] as FieldKey[]) {
    input(key).addEventListener("input", () => {
      const f = state.fields[key];
      f.source = "manual";
      f.level = undefined;
      f.note = undefined;
      f.value = input(key).value;
      updateFieldUi();
      updateOutput();
    });
  }

  $("btn-copy-url").addEventListener("click", (e) => void copy($("payme-url").textContent ?? "", e.currentTarget as HTMLElement));
  $("btn-share").hidden = typeof navigator.share !== "function";
  $("btn-share").addEventListener("click", (e) => void shareLink(e.currentTarget as HTMLElement));
  $("btn-save-qr").addEventListener("click", (e) => void saveQr(e.currentTarget as HTMLElement));
  $("btn-save-photo").addEventListener("click", (e) => void savePhoto(e.currentTarget as HTMLElement));
  $("btn-copy-diag").addEventListener("click", (e) => void copy($("diag").textContent ?? "", e.currentTarget as HTMLElement));
  $("btn-again").addEventListener("click", () => show("start"));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && stream) {
      stopCamera();
      if (!$("view-camera").hidden) show("start");
    }
  });

  state.fields = emptyFields();
  show("start");
  registerServiceWorker();
}

wire();
