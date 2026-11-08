// IBAN (ISO 13616) and Slovak legacy account helpers.

/** Remainder of a long decimal string divided by 97. */
export function mod97(digits: string): number {
  let rem = 0;
  for (const ch of digits) {
    rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  }
  return rem;
}

/** Letters A=10 .. Z=35, digits unchanged. */
function ibanToDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) out += String(c - 55);
    else out += ch;
  }
  return out;
}

export function normalizeIban(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/** True when the IBAN passes mod-97 and, for SK, has 24 characters. */
export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith("SK") && !/^SK\d{22}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  return mod97(ibanToDigits(rearranged)) === 1;
}

/** Group an IBAN in blocks of four for display. */
export function formatIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Slovak BBAN (bank 4 + predcislie 6 + zaklad 10) to IBAN.
 * Check digits = 98 - mod97(BBAN + "282000"), padded to 2 digits.
 */
export function bbanToIban(bank: string, predcislie: string, zaklad: string): string {
  const bban = bank.padStart(4, "0") + predcislie.padStart(6, "0") + zaklad.padStart(10, "0");
  const check = 98 - mod97(bban + "282000");
  return "SK" + String(check).padStart(2, "0") + bban;
}

const ACCOUNT_WEIGHTS = [6, 3, 7, 9, 10, 5, 8, 4, 2, 1];

/**
 * Legacy Slovak account mod-11 check. zaklad uses all ten weights,
 * predcislie the last six. Each weighted sum must be divisible by 11.
 */
export function isValidLegacyPart(part: string): boolean {
  if (!/^\d+$/.test(part)) return false;
  const w = ACCOUNT_WEIGHTS.slice(ACCOUNT_WEIGHTS.length - part.length);
  if (w.length !== part.length) return false;
  let sum = 0;
  for (let i = 0; i < part.length; i++) sum += (part.charCodeAt(i) - 48) * w[i];
  return sum % 11 === 0;
}

/** Split an SK IBAN into bank code, predcislie and zaklad. */
export function splitSkIban(iban: string): { bank: string; predcislie: string; zaklad: string } | null {
  const n = normalizeIban(iban);
  if (!/^SK\d{22}$/.test(n)) return null;
  return { bank: n.slice(4, 8), predcislie: n.slice(8, 14), zaklad: n.slice(14, 24) };
}

// Slovak bank codes. Informational only: an unknown code is a note, not an error,
// because this list is not the full NBS register.
export const BANK_CODES: Record<string, string> = {
  "0200": "VÚB",
  "0720": "Národná banka Slovenska",
  "0900": "Slovenská sporiteľňa",
  "1100": "Tatra banka",
  "1111": "UniCredit Bank",
  "3100": "Prima banka (ex Sberbank)",
  "5200": "OTP Banka",
  "5600": "Prima banka",
  "6500": "365.bank (Poštová banka)",
  "7500": "ČSOB",
  "8180": "Štátna pokladnica",
  "8330": "Fio banka",
  "8360": "mBank",
};

export function bankName(iban: string): string | undefined {
  const p = splitSkIban(iban);
  return p ? BANK_CODES[p.bank] : undefined;
}
