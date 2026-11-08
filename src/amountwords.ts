// The form prints the euro part in Slovak words ("=Dvadsaťosem="). It is an
// independent reading of the amount. The cents are not in the words.

const ONES = ["", "jeden", "dva", "tri", "styri", "pat", "sest", "sedem", "osem", "devat"];
const TEENS = ["desat", "jedenast", "dvanast", "trinast", "strnast", "patnast", "sestnast", "sedemnast", "osemnast", "devatnast"];
const TENS = ["", "", "dvadsat", "tridsat", "styridsat", "patdesiat", "sestdesiat", "sedemdesiat", "osemdesiat", "devatdesiat"];
const HUNDREDS = ["", "sto", "dvesto", "tristo", "styristo", "patsto", "seststo", "sedemsto", "osemsto", "devatsto"];
const THOUSANDS = ["", "tisic", "dvetisic", "tritisic", "styritisic", "pattisic", "sesttisic", "sedemtisic", "osemtisic", "devattisic"];

const MAX_EUROS = 9999;

/** Slovak words for 1 to 9999, in lower case and without diacritics. */
export function euroWords(n: number): string {
  const rest = n % 100;
  const low = rest >= 10 && rest < 20 ? TEENS[rest - 10] : TENS[Math.floor(rest / 10)] + ONES[rest % 10];
  return THOUSANDS[Math.floor(n / 1000)] + HUNDREDS[Math.floor(n / 100) % 10] + low;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const TABLE = Array.from({ length: MAX_EUROS }, (_, i) => ({ euros: i + 1, word: euroWords(i + 1) }));

/** The euro value of the words, or undefined when no single number fits closely. */
export function parseEuroWords(text: string): number | undefined {
  const s = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (s.length < 3) return undefined;
  const limit = Math.max(1, Math.floor(s.length / 6));
  let best: number | undefined;
  let bestDist = Infinity;
  let ties = 0;
  for (const { euros, word } of TABLE) {
    if (Math.abs(word.length - s.length) > limit) continue;
    const d = distance(s, word);
    if (d < bestDist) {
      bestDist = d;
      best = euros;
      ties = 1;
    } else if (d === bestDist) {
      ties++;
    }
  }
  return bestDist <= limit && ties === 1 ? best : undefined;
}
