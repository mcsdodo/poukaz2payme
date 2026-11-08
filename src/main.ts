import "@fontsource/ibm-plex-sans-condensed/400.css";
import "@fontsource/ibm-plex-sans-condensed/500.css";
import "@fontsource/ibm-plex-sans-condensed/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./style.css";
import QRCode from "qrcode";
import { decode as decodeBySquare } from "bysquare/pay";
import { decodeCanvas, lastZxingError, nativeFormats, orientationFromCorners, warmUpBarcode, type BarcodeHit } from "./barcode";
import { extractFields, type BBox, type Extracted, type ExtractResult } from "./extract";
import { bankName, formatIban, isValidIban, normalizeIban, splitSkIban, isValidLegacyPart } from "./iban";
import { getOcrWorker, ocrBoxedDigits, ocrDigits, ocrPage, setOcrProgress } from "./ocr";
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

function rotateCanvas(src: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return src;
  const c = document.createElement("canvas");
  const swap = d === 90 || d === 270;
  c.width = swap ? src.height : src.width;
  c.height = swap ? src.width : src.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Grayscale + contrast stretch, which helps Tesseract on phone photos. */
function prepareForOcr(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = canvasFrom(src, src.width, src.height, 2400);
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

let stream: MediaStream | null = null;
let scanning = false;
let torchOn = false;

async function startCamera(): Promise<void> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Kamera vyžaduje HTTPS a podporovaný prehliadač. Použite \"Vybrať z galérie\".");
  }
  if (!stream || stream.getVideoTracks().every((t) => t.readyState === "ended")) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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

function pauseCamera(): void {
  scanning = false;
  stream?.getVideoTracks().forEach((t) => (t.enabled = false));
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

async function grabStill(): Promise<HTMLCanvasElement | null> {
  const track = stream?.getVideoTracks()[0];
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
  if (track && IC) {
    try {
      const blob = await new IC(track).takePhoto();
      const bmp = await createImageBitmap(blob);
      const c = canvasFrom(bmp, bmp.width, bmp.height, 3200);
      bmp.close();
      return c;
    } catch {
      // fall back to the video frame
    }
  }
  return videoFrame(3200);
}

function isPoukazHit(h: BarcodeHit): boolean {
  if (h.format !== "Code128") return false;
  const p = parsePoukazBarcode(h.text);
  return !!p && (p.ibanValid || p.variant === "product37");
}

async function scanLoop(): Promise<void> {
  scanning = true;
  let frames = 0;
  while (scanning) {
    const frame = videoFrame(1920);
    if (frame) {
      frames++;
      const hits = await decodeCanvas(frame).catch(() => [] as BarcodeHit[]);
      if (!scanning) return;
      const good = hits.find(isPoukazHit);
      if (good) {
        $("cam-status").textContent = "Kód prečítaný, fotím...";
        await shoot();
        return;
      }
      const other = hits.find((h) => h.format !== "Code128");
      $("cam-status").textContent = other
        ? `Vidím ${other.format}, hľadám čiarový kód poukazu...`
        : hits.length
          ? "Kód nevyzerá ako poukaz, skúste priblížiť."
          : `Hľadám čiarový kód... (${frames})`;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function shoot(): Promise<void> {
  scanning = false;
  const still = await grabStill();
  pauseCamera();
  if (!still) {
    showStartError("Nepodarilo sa odfotiť.");
    return;
  }
  await processImage(still, 0);
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

async function processImage(input: HTMLCanvasElement, extraRotation: number): Promise<void> {
  show("work");
  state.fields = emptyFields();
  state.alerts = [];
  state.blocked = false;
  state.source = input;
  const diag: Record<string, unknown> = {
    app: `${__APP_VERSION__} (${__BUILD_TIME__})`,
    ua: navigator.userAgent,
    nativeBarcodeFormats: nativeFormats,
    input: { w: input.width, h: input.height },
    camera: state.diag.camera,
  };
  state.diag = diag;
  const t0 = performance.now();

  try {
    // 1. Barcode on the image as delivered.
    step("barcode");
    setWork("Čítam čiarový kód...");
    let canvas = rotateCanvas(canvasFrom(input, input.width, input.height, 2400), extraRotation);
    let hits = await decodeCanvas(canvas);
    diag.barcodeHits = hits.map((h) => ({ engine: h.engine, format: h.format, text: h.text, orientation: h.orientation }));
    diag.zxingError = lastZxingError;

    // 2. Rotate so the poukaz barcode is horizontal: it anchors the text direction.
    const pk = hits.find((h) => h.format === "Code128" && parsePoukazBarcode(h.text));
    let rotation = extraRotation;
    if (pk) {
      const a = orientationFromCorners(pk.position);
      if (a !== 0) {
        canvas = rotateCanvas(canvas, -a);
        rotation = (rotation - a + 360) % 360;
      }
    }
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
    const ocrCanvas = prepareForOcr(canvas);
    const page = await ocrPage(ocrCanvas);
    diag.ocrMs = page.ms;
    diag.ocrText = page.text;
    diag.ocrLines = page.lines;
    const ex = extractFields(page.lines);
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
    await secondPass(ocrCanvas, canvas, ex, diag);

    diag.barcode = barcode;
    merge(barcode, ex, ocrCanvas);
    diag.totalMs = Math.round(performance.now() - t0);

    setPhoto(canvasFrom(canvas, canvas.width, canvas.height, 1200));

    renderResult();
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
      if (parseAmount(r.text)) ex.amount = { value: r.text.replace(/^=/, ""), confidence: r.confidence * 0.8, bbox: rect, labelBox: b };
      continue;
    }
    // The crop starts inside the label on purpose: the label then touches the
    // crop edge and segmentCells drops it. VS and SS have ten cells.
    const max = key === "ks" ? 4 : 10;
    const rect: BBox = { x0: b.x0 - w * 0.15, y0: b.y1 - h * 0.6, x1: b.x1 + w * (key === "ks" ? 0.6 : 1.4), y1: b.y1 + h * 3 };
    const r = await ocrBoxedDigits(colorCanvas, rect, max, key === "ks" ? isKnownKsClass : undefined);
    tries[key] = r;
    if (r.text) {
      ex[key] = { value: r.text, confidence: r.confidence, bbox: rect, labelBox: b };
    } else if (key === "ks") {
      const value = r.partials.map(completeKs).find(Boolean);
      if (value) ex.ks = { value, confidence: 40, bbox: rect, labelBox: b, filled: true };
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
  const cents = await ocrBoxedDigits(colorCanvas, centRect, 2, (t) => t.length === 2);
  const tries = { euros, cents };
  const bbox: BBox = { x0: eurRect.x0, y0: top, x1: centRect.x1, y1: bottom };
  if (cents.text.length !== 2) return { tries };
  if (words !== undefined && Number(euros.text) !== words) {
    // Unreadable euros with known words: the words give the euros. Never replace digits that exist.
    if (current !== undefined) return { tries };
    return { tries, value: { value: `${words},${cents.text}`, confidence: Math.min(ex.amountWords!.confidence, cents.confidence), bbox, filled: true } };
  }
  if (!euros.text) return { tries };
  return { tries, value: { value: `${Number(euros.text)},${cents.text}`, confidence: Math.min(euros.confidence, cents.confidence), bbox } };
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
      setField(key, o.value, "ocr", ocrLevel(o.confidence), crop(o.bbox));
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
    if (o?.value) setField(key, o.value, "ocr", "low", crop(o.bbox));
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

  $("btn-camera").addEventListener("click", async () => {
    $("start-error").hidden = true;
    try {
      show("camera");
      $("cam-status").textContent = "Spúšťam kameru...";
      await startCamera();
      warmUpBarcode();
      void getOcrWorker().catch(() => {});
      void scanLoop();
    } catch (e) {
      showStartError(e instanceof Error ? e.message : String(e));
    }
  });

  $("btn-shoot").addEventListener("click", () => void shoot());
  $("btn-torch").addEventListener("click", () => void setTorch(!torchOn));
  $("btn-cam-cancel").addEventListener("click", () => {
    pauseCamera();
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
    if (state.source) void processImage(state.source, (state.rotation + state.turn) % 360);
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
  $("btn-copy-diag").addEventListener("click", (e) => void copy($("diag").textContent ?? "", e.currentTarget as HTMLElement));
  $("btn-again").addEventListener("click", () => show("start"));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && stream) {
      scanning = false;
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      if (!$("view-camera").hidden) show("start");
    }
  });

  state.fields = emptyFields();
  show("start");
}

wire();
