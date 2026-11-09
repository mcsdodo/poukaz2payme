/** Lower case without accents, for matching OCR text against labels. */
export function strip(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const ACUTE: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", l: "ĺ", r: "ŕ" };
const CARON: Record<string, string> = { c: "č", d: "ď", l: "ľ", n: "ň", s: "š", t: "ť", z: "ž" };

/**
 * The Slovak letter with `marks` separate marks above it: two dots on a (ä), an
 * acute on a vowel, a caron on a consonant. Tesseract reads a lone é as e; the
 * cut-out sees the mark but not its shape, and Slovak puts acutes on vowels and
 * carons on consonants (ĺ and ŕ are rare).
 */
export function accented(ch: string, marks: number): string {
  const low = ch.toLowerCase();
  const out = marks >= 2 && low === "a" ? "ä" : "aeiouy".includes(low) ? ACUTE[low] : CARON[low];
  if (!out) return ch;
  return ch === low ? out : out.toUpperCase();
}
