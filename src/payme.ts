// payme link standard 2.0 (SBA), type /p/, plus the PAY by square QR string.

import { CurrencyCode, encode, PaymentOptions } from "bysquare/pay";
import { normalizeIban } from "./iban";

export interface Payment {
  iban: string;
  /** Amount in cents. */
  amountCents?: number;
  vs?: string;
  ss?: string;
  ks?: string;
  message?: string;
  creditorName: string;
  /** YYYYMMDD */
  dueDate?: string;
}

/** ASCII without diacritics, as payme CN requires. */
export function toAscii(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** "12,50" / "12.5" / "1 200,00" -> cents, or undefined. */
export function parseAmount(s: string): number | undefined {
  const t = s.replace(/[\s=€]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  const cents = Math.round(parseFloat(t) * 100);
  return cents > 0 ? cents : undefined;
}

export function paymentIdentification(p: Pick<Payment, "vs" | "ss" | "ks">): string {
  let pi = "";
  if (p.vs) pi += "/VS" + p.vs;
  if (p.ss) pi += "/SS" + p.ss;
  if (p.ks) pi += "/KS" + p.ks;
  return pi;
}

export class PaymeError extends Error {}

export function buildPaymeLink(p: Payment): string {
  const iban = normalizeIban(p.iban);
  const cn = toAscii(p.creditorName).slice(0, 70);
  if (!iban) throw new PaymeError("Chýba IBAN.");
  if (!cn) throw new PaymeError("Chýba meno príjemcu.");
  const q = new URLSearchParams();
  q.set("IBAN", iban);
  if (p.amountCents) {
    q.set("AM", formatAmount(p.amountCents));
    q.set("CC", "EUR");
  }
  if (p.dueDate) q.set("DT", p.dueDate);
  const pi = paymentIdentification(p);
  if (pi) q.set("PI", pi);
  if (p.message) q.set("MSG", p.message.slice(0, 140));
  q.set("CN", cn);
  return "https://payme.sk/2/p/PME?" + q.toString();
}

export function buildBySquare(p: Payment): string {
  return encode({
    payments: [
      {
        type: PaymentOptions.PaymentOrder,
        amount: p.amountCents ? p.amountCents / 100 : undefined,
        currencyCode: CurrencyCode.EUR,
        paymentDueDate: p.dueDate,
        variableSymbol: p.vs,
        specificSymbol: p.ss,
        constantSymbol: p.ks,
        paymentNote: p.message ? p.message.slice(0, 140) : undefined,
        bankAccounts: [{ iban: normalizeIban(p.iban) }],
        beneficiary: { name: toAscii(p.creditorName).slice(0, 70) },
      },
    ],
  });
}
