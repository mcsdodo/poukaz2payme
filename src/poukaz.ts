// Parser for the Code 128C barcode in the reading zone of a Slovak
// "Poštový poukaz na účet". Layouts come from the 2016 Technické parametre
// (as summarised in the design doc). Fields left for hand filling are zeros.

import { bbanToIban, isValidIban } from "./iban";

export type Variant = "iban48" | "bban50" | "product37" | "bianco" | "unknown";

export interface PoukazBarcode {
  raw: string;
  variant: Variant;
  product: string;
  service?: string;
  iban?: string;
  /** IBAN passes mod-97. This is the acceptance gate, not mod-11. */
  ibanValid: boolean;
  vs?: string;
  ks?: string;
  ss?: string;
  reference?: string;
  processing?: string;
  /** Amount in cents, undefined when the barcode holds zeros. */
  amountCents?: number;
  /** Mod-11 check digit result; a signal only, never a gate. */
  mod11: "ok" | "fail" | "n/a";
  notes: string[];
}

const WEIGHTS = [7, 8, 6, 4, 2, 3, 5, 9];

/**
 * Mod-11 check digit for the 48- and 50-digit payloads. The weights repeat
 * 7 8 6 4 2 3 5 9 over the first 49 digits; the 48-digit variant starts at the
 * third weight. Check = 11 - remainder; 10 -> 0, 11 -> 5.
 */
export function mod11CheckDigit(payloadWithoutCheck: string): number {
  const offset = payloadWithoutCheck.length === 47 ? 2 : 0;
  let sum = 0;
  for (let i = 0; i < payloadWithoutCheck.length; i++) {
    sum += (payloadWithoutCheck.charCodeAt(i) - 48) * WEIGHTS[(i + offset) % WEIGHTS.length];
  }
  const c = 11 - (sum % 11);
  if (c === 10) return 0;
  if (c === 11) return 5;
  return c;
}

function nonZero(s: string): string | undefined {
  const t = s.replace(/^0+/, "");
  return t === "" ? undefined : t;
}

function amount(s: string): number | undefined {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parsePoukazBarcode(text: string): PoukazBarcode | null {
  const raw = text.replace(/\s/g, "");
  if (!/^\d+$/.test(raw)) return null;

  const base = { raw, ibanValid: false, notes: [] as string[] };

  if (raw.length === 4) {
    return { ...base, variant: "bianco", product: raw.slice(0, 2), service: raw.slice(2, 4), mod11: "n/a" };
  }
  if (raw.length !== 48 && raw.length !== 50) return null;

  const mod11 = mod11CheckDigit(raw.slice(0, -1)) === raw.charCodeAt(raw.length - 1) - 48 ? "ok" : "fail";
  const product = raw.slice(0, 2);
  const service = raw.slice(2, 4);

  if (raw.length === 48) {
    // product 2, service 2, country 2, IBAN check 2, bank 4, account 16, VS 10, processing 1, amount 8, check 1
    const country = raw.slice(4, 6);
    const check = raw.slice(6, 8);
    const bank = raw.slice(8, 12);
    const account = raw.slice(12, 28);
    const iban = "SK" + check + bank + account;
    const r: PoukazBarcode = {
      ...base,
      variant: "iban48",
      product,
      service,
      iban,
      ibanValid: isValidIban(iban),
      vs: nonZero(raw.slice(28, 38)),
      processing: raw.slice(38, 39),
      amountCents: amount(raw.slice(39, 47)),
      mod11,
    };
    if (country !== "01") r.notes.push(`Kód krajiny "${country}" nie je "01".`);
    return r;
  }

  if (product === "37") {
    // product 2, service 2, reference 9, VS 10, SS 10, KS 4, filler 1, processing 1, amount 10, check 1
    return {
      ...base,
      variant: "product37",
      product,
      service,
      reference: raw.slice(4, 13),
      vs: nonZero(raw.slice(13, 23)),
      ss: nonZero(raw.slice(23, 33)),
      ks: nonZero(raw.slice(33, 37)),
      processing: raw.slice(38, 39),
      amountCents: amount(raw.slice(39, 49)),
      mod11,
    };
  }

  // BBAN variant: product 2, service 2, account 16, bank 4, VS 10, KS 4, processing 1, amount 10, check 1
  const account = raw.slice(4, 20);
  const bank = raw.slice(20, 24);
  const iban = bbanToIban(bank, account.slice(0, 6), account.slice(6, 16));
  return {
    ...base,
    variant: "bban50",
    product,
    service,
    iban,
    ibanValid: isValidIban(iban) && /[1-9]/.test(account),
    vs: nonZero(raw.slice(24, 34)),
    ks: nonZero(raw.slice(34, 38)),
    processing: raw.slice(38, 39),
    amountCents: amount(raw.slice(39, 49)),
    mod11,
  };
}

export interface ProductAdvice {
  level: "info" | "warn" | "block";
  text: string;
}

export function productAdvice(product: string | undefined): ProductAdvice | undefined {
  switch (product) {
    case "36":
      return {
        level: "warn",
        text: "Produkt 36: účet môže byť zberný účet zmluvnej banky. Overte u príjemcu, že prevod priradí.",
      };
    case "37":
      return {
        level: "warn",
        text: "Produkt 37: účet je skrytý za referenčným číslom pošty. IBAN z čiarového kódu nie je k dispozícii, overte vytlačený IBAN.",
      };
    case "39":
      return { level: "info", text: "Bianco poukaz: čiarový kód neobsahuje platobné údaje, všetko je z OCR alebo ručne." };
    default:
      return undefined;
  }
}
