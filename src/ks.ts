// Known classes of the konštantný symbol: its first three digits, which say what
// the payment is for. The fourth digit says how it is paid (8 non-cash, 9 cash, and
// others), and it is independent of the class. For example, the Slovak bank lists
// have 0178 but not 0179, and a real poukaz carries 0179. So this list only checks
// a reading and never corrects one.
// Sources (2026-11-08): the Tatra banka and Prima banka lists of the most used KS,
// and the longer historic list on portal.pohoda.cz.

const KS_CLASSES = new Set(
  `
  000 002 003 005 006 007 009 010 011 013 014 015 016 017 025 027
  030 035 037 040 041 045 047 049 055 057 059 085 089 093 095 096
  101 111 114 131 134 137 151 154 155 174 175 181 194 195 197 201
  205 214 251 255 261 269 271 294 297 301 305 309 311 314 321 334
  351 354 355 361 369 371 374 381 405 409 414 421 431 451 461 471
  481 491 494 501 505 511 514 531 534 551 561 574 591 594 614 634
  641 654 674 694 711 714 721 734 751 754 761 771 774 794 814 874
  911 914 961 981 991
`.trim().split(/\s+/),
);

export function isKnownKsClass(ks: string): boolean {
  return KS_CLASSES.has(ks.padStart(4, "0").slice(0, 3));
}
/**
 * Fills one unreadable digit of the class when exactly one known class fits.
 * The last digit is never filled, because it does not depend on the class.
 */
export function completeKs(cells: (string | null)[]): string | undefined {
  if (cells.length !== 4 || cells[3] === null) return undefined;
  const gaps = cells.flatMap((c, i) => (c === null ? [i] : []));
  if (gaps.length !== 1) return undefined;
  const fits = [...KS_CLASSES].filter((k) => [0, 1, 2].every((i) => i === gaps[0] || k[i] === cells[i]));
  return fits.length === 1 ? fits[0] + cells[3] : undefined;
}
