import { describe, expect, it } from "vitest";
import { decode } from "bysquare/pay";
import { bbanToIban, isValidIban, isValidLegacyPart, mod97 } from "../src/iban";
import { mod11CheckDigit, parsePoukazBarcode } from "../src/poukaz";
import { buildBySquare, buildPaymeLink, parseAmount, toAscii } from "../src/payme";
import { extractFields, findIban, type OcrLine } from "../src/extract";
import { segmentCells } from "../src/cells";
import { fitLayout } from "../src/layout";
import { rotatePoint, rotatedSize, zoneSkew } from "../src/deskew";
import { completeKs, isKnownKsClass } from "../src/ks";
import { euroWords, parseEuroWords } from "../src/amountwords";
import realLines from "./fixtures/poukaz-real-form.lines.json";

// Independent vectors: the IBAN and the payme link come from the design doc.
// The barcode vectors below are built with this code's own mod-11, so they only
// prove internal consistency, not agreement with real printed forms.

describe("IBAN", () => {
  it("accepts the doc's example IBAN", () => {
    expect(isValidIban("SK3911000000002941016716")).toBe(true);
    expect(isValidIban("SK39 1100 0000 0029 4101 6716")).toBe(true);
  });
  it("rejects a single wrong digit", () => {
    expect(isValidIban("SK3911000000002941016717")).toBe(false);
  });
  it("converts BBAN to the same IBAN", () => {
    expect(bbanToIban("1100", "000000", "2941016716")).toBe("SK3911000000002941016716");
  });
  it("mod97 handles long strings", () => {
    expect(mod97("97")).toBe(0);
    expect(mod97("98")).toBe(1);
  });
  it("legacy account mod-11", () => {
    expect(isValidLegacyPart("2941016716")).toBe(true); // a real Tatra banka account from the doc
    expect(isValidLegacyPart("2941016717")).toBe(false);
  });
});

function withCheck(payload: string): string {
  return payload + String(mod11CheckDigit(payload));
}

describe("poukaz barcode", () => {
  const iban48 = withCheck(
    "38" + "01" + "01" + "39" + "1100" + "000000" + "2941016716" + "0000001111" + "0" + "00001500",
  );

  it("parses the 48-digit IBAN variant", () => {
    expect(iban48).toHaveLength(48);
    const r = parsePoukazBarcode(iban48)!;
    expect(r.variant).toBe("iban48");
    expect(r.iban).toBe("SK3911000000002941016716");
    expect(r.ibanValid).toBe(true);
    expect(r.vs).toBe("1111");
    expect(r.amountCents).toBe(1500);
    expect(r.mod11).toBe("ok");
  });

  it("treats zero fields as empty", () => {
    const code = withCheck("38" + "01" + "01" + "39" + "1100" + "000000" + "2941016716" + "0".repeat(10) + "0" + "0".repeat(8));
    const r = parsePoukazBarcode(code)!;
    expect(r.ibanValid).toBe(true);
    expect(r.vs).toBeUndefined();
    expect(r.amountCents).toBeUndefined();
  });

  it("keeps the IBAN when only mod-11 fails", () => {
    const bad = iban48.slice(0, 47) + String((Number(iban48[47]) + 1) % 10);
    const r = parsePoukazBarcode(bad)!;
    expect(r.mod11).toBe("fail");
    expect(r.ibanValid).toBe(true);
  });

  it("parses the 50-digit BBAN variant", () => {
    const code = withCheck("36" + "01" + "000000" + "2941016716" + "1100" + "0000001111" + "0308" + "0" + "0000002550");
    expect(code).toHaveLength(50);
    const r = parsePoukazBarcode(code)!;
    expect(r.variant).toBe("bban50");
    expect(r.iban).toBe("SK3911000000002941016716");
    expect(r.ks).toBe("308");
    expect(r.amountCents).toBe(2550);
  });

  it("parses product 37 without an IBAN", () => {
    const code = withCheck("37" + "01" + "123456789" + "0000001111" + "0000001148" + "0308" + "0" + "0" + "0000001000");
    const r = parsePoukazBarcode(code)!;
    expect(r.variant).toBe("product37");
    expect(r.iban).toBeUndefined();
    expect(r.reference).toBe("123456789");
    expect(r.ss).toBe("1148");
  });

  it("rejects other lengths", () => {
    expect(parsePoukazBarcode("12345")).toBeNull();
    expect(parsePoukazBarcode("abc")).toBeNull();
  });
});

describe("payme", () => {
  it("matches the doc's example link exactly", () => {
    const url = buildPaymeLink({
      iban: "SK3911000000002941016716",
      amountCents: 1500,
      vs: "1111",
      ss: "1148",
      ks: "0308",
      message: "Poistne 2026",
      creditorName: "Alice Payee",
    });
    expect(url).toBe(
      "https://payme.sk/2/p/PME?IBAN=SK3911000000002941016716&AM=15.00&CC=EUR&PI=%2FVS1111%2FSS1148%2FKS0308&MSG=Poistne+2026&CN=Alice+Payee",
    );
  });
  it("strips diacritics from CN and omits empty PI parts", () => {
    const url = buildPaymeLink({ iban: "SK3911000000002941016716", vs: "42", creditorName: "Základná škola Žilina" });
    expect(url).toContain("CN=Zakladna+skola+Zilina");
    expect(url).toContain("PI=%2FVS42&");
    expect(url).not.toContain("AM=");
  });
  it("refuses a link without a creditor name", () => {
    expect(() => buildPaymeLink({ iban: "SK3911000000002941016716", creditorName: "  " })).toThrow();
  });
  it("toAscii", () => {
    expect(toAscii("Ďaľší účet")).toBe("Dalsi ucet");
  });
  it("parseAmount", () => {
    expect(parseAmount("=12,50")).toBe(1250);
    expect(parseAmount("1 200,00")).toBe(120000);
    expect(parseAmount("0,00")).toBeUndefined();
    expect(parseAmount("abc")).toBeUndefined();
  });
});

describe("PAY by square", () => {
  it("round-trips through bysquare decode", () => {
    const qr = buildBySquare({
      iban: "SK3911000000002941016716",
      amountCents: 1550,
      vs: "1111",
      ks: "0308",
      message: "Skola",
      creditorName: "Škola",
    });
    const model = decode(qr);
    const p = model.payments[0];
    expect(p.bankAccounts[0].iban).toBe("SK3911000000002941016716");
    expect(p.amount).toBe(15.5);
    expect(p.variableSymbol).toBe("1111");
    expect(p.constantSymbol).toBe("0308");
    expect(p.beneficiary?.name).toBe("Skola");
  });
});

function line(text: string, x0: number, y0: number, x1 = x0 + 400, y1 = y0 + 30): OcrLine {
  return { text, bbox: { x0, y0, x1, y1 }, confidence: 80 };
}

describe("OCR extraction", () => {
  it("finds an IBAN with OCR confusions", () => {
    expect(findIban("Cislo uctu SK39 11OO 0000 0029 41O1 6716")).toBe("SK3911000000002941016716");
  });
  it("reads symbols and amount from labels", () => {
    const r = extractFields([
      line("Číslo účtu adresáta (IBAN)", 100, 20),
      line("Variabilný symbol", 100, 100),
      line("| 1 | 2 | 3 | 4 | 5 |", 100, 140),
      line("Konštantný symbol 0308", 600, 100),
      line("Suma číslom", 100, 300),
      line("=25,50", 100, 340),
      line("Meno a priezvisko (názov) adresáta", 100, 500),
      line("Základná škola Hlavná", 100, 540),
      line("Správa pre adresáta", 100, 600),
      line("Obedy november", 100, 640),
      line("SK39 1100 0000 0029 4101 6716", 100, 700),
    ]);
    expect(r.vs?.value).toBe("12345");
    expect(r.ks?.value).toBe("0308");
    expect(r.amount?.value).toBe("25,50");
    expect(r.name?.value).toBe("Základná škola Hlavná");
    expect(r.iban?.value).toBe("SK3911000000002941016716");
    expect(r.message?.value).toBe("Obedy november");
  });
  it("collects 48-digit clear text runs", () => {
    const digits = "38010139110000000029410167160000001111000001500" + "7";
    const r = extractFields([line(digits.replace(/(.{8})/g, "$1 "), 0, 900)]);
    expect(r.barcodeDigits).toEqual([digits]);
  });
});

// OCR output from a photo of a real poukaz. All personal and payment data is
// replaced with fake values that keep the same shape. The barcode holds zeros for VS and amount, so OCR is the only
// source for them. A Diagnostika dump of a failed form can be added the same way.
describe("KS class", () => {
  it("knows the class of a cash variant that the bank lists do not print", () => {
    expect(isKnownKsClass("0179")).toBe(true);
    expect(isKnownKsClass("0178")).toBe(true);
  });
  it("knows common classes and pads short values", () => {
    expect(isKnownKsClass("0308")).toBe(true);
    expect(isKnownKsClass("308")).toBe(true);
  });
  it("rejects a class outside the list", () => {
    expect(isKnownKsClass("9998")).toBe(false);
  });
});

describe("KS gap filling", () => {
  it("fills one unreadable class digit when only one class fits", () => {
    expect(completeKs([null, "1", "7", "9"])).toBe("0179");
  });
  it("does not guess when several classes fit", () => {
    expect(completeKs(["0", null, "7", "9"])).toBeUndefined();
  });
  it("never fills the method digit", () => {
    expect(completeKs(["0", "1", "7", null])).toBeUndefined();
  });
  it("does not fill two gaps", () => {
    expect(completeKs([null, null, "7", "9"])).toBeUndefined();
  });
});

describe("amount in words", () => {
  it("builds Slovak number words", () => {
    expect(euroWords(28)).toBe("dvadsatosem");
    expect(euroWords(15)).toBe("patnast");
    expect(euroWords(121)).toBe("stodvadsatjeden");
    expect(euroWords(1200)).toBe("tisicdvesto");
    expect(euroWords(2005)).toBe("dvetisicpat");
  });
  it("reads the printed form, with or without diacritics", () => {
    expect(parseEuroWords("=Dvadsaťosem=")).toBe(28);
    expect(parseEuroWords("=Dvadsatosem=")).toBe(28);
  });
  it("tolerates a small OCR error", () => {
    expect(parseEuroWords("=Dvadsatasem=")).toBe(28);
  });
  it("rejects text that is not a number", () => {
    expect(parseEuroWords("=Stravne=")).toBeUndefined();
    expect(parseEuroWords("xq")).toBeUndefined();
  });
});

describe("OCR extraction on a real form", () => {
  const lines = realLines as OcrLine[];
  const r = extractFields(lines);

  it("reads the amount from separate EUR and cent columns", () => {
    expect(r.amount?.value).toBe("28,50");
  });
  it("reads VS from the plain copy on the left, not the boxed noise", () => {
    expect(r.vs?.value).toBe("445577");
  });
  it("finds the abbreviated KONST. label and leaves its boxed value to the cell pass", () => {
    expect(r.ks?.value).toBe("");
    expect(r.ks?.labelBox).toBeDefined();
  });
  it("does not take the reference number as SS", () => {
    expect(r.ss?.value ?? "").toBe("");
  });
  it("reads the amount in words", () => {
    expect(r.amountWords?.euros).toBe(28);
  });
  it("finds the boxed EUR and cent columns", () => {
    expect(r.amountColumns?.eur.x0).toBe(1403);
    expect(r.amountColumns?.cent.x0).toBe(1495);
  });
  it("keeps IBAN and name", () => {
    expect(r.iban?.value).toBe("SK9156000000001234567890");
    expect(r.name?.value).toBe("ZÁKLADNÁ ŠKOLA VZOROVÁ");
  });
});

describe("OCR extraction rules", () => {
  it("accepts the abbreviated KS label with the value on the line", () => {
    expect(extractFields([line("KONŠT. SYMBOL 0179", 100, 100)]).ks?.value).toBe("0179");
  });
  it("does not take digits out of a noisy boxed line", () => {
    const r = extractFields([line("Variabilný symbol", 100, 100), line("1l1}olelolel0ln i7 194", 100, 140)]);
    expect(r.vs?.value).toBe("");
  });
  it("needs a real digit, not only look-alikes", () => {
    expect(extractFields([line("KONŠT. SYMBOL l", 100, 100)]).ks?.value).toBe("");
  });
});

/** Grayscale page as RGBA; `ink` paints dark rectangles. */
function page(w: number, h: number, ink: [number, number, number, number][], faint: [number, number, number, number][] = []) {
  const data = new Uint8ClampedArray(w * h * 4).fill(210);
  const paint = (r: [number, number, number, number], v: number) => {
    for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) data.fill(v, (y * w + x) * 4, (y * w + x) * 4 + 3);
  };
  faint.forEach((r) => paint(r, 170));
  ink.forEach((r) => paint(r, 20));
  return { data, width: w, height: h };
}

describe("segmentCells", () => {
  it("returns one tile per printed character, left to right", () => {
    const img = page(200, 60, [
      [120, 15, 135, 45],
      [40, 15, 55, 45],
    ]);
    const tiles = segmentCells(img, 0.5);
    expect(tiles.map((t) => t.x)).toEqual([40, 120]);
    expect(tiles[0].width).toBeGreaterThan(15);
  });
  it("drops shapes touching the crop edge, like the table or a label remnant", () => {
    const img = page(200, 60, [
      [40, 15, 55, 45],
      [150, 0, 200, 60],
      [60, 0, 100, 4],
    ]);
    expect(segmentCells(img, 0.5).map((t) => t.x)).toEqual([40]);
  });
  it("ignores faint cell borders and specks", () => {
    const img = page(200, 60, [
      [40, 15, 55, 45],
      [100, 30, 103, 33],
    ], [[70, 5, 72, 55]]);
    expect(segmentCells(img, 0.5).map((t) => t.x)).toEqual([40]);
  });
  it("returns nothing when the only shape is a speck", () => {
    expect(segmentCells(page(100, 40, [[50, 18, 54, 22]]), 0.5)).toEqual([]);
  });
  it("drops thin pieces of a cell border next to a character", () => {
    const img = page(200, 60, [
      [40, 15, 55, 45],
      [100, 15, 102, 45],
    ]);
    expect(segmentCells(img, 0.5).map((t) => t.x)).toEqual([40]);
  });
  it("returns nothing for an empty crop", () => {
    expect(segmentCells(page(100, 40, []), 0.5)).toEqual([]);
  });
});

describe("form template", () => {
  const lines = realLines as OcrLine[];
  const without = (re: RegExp, maxX = Infinity) => lines.filter((l) => !(re.test(l.text) && l.bbox.x0 < maxX));
  const near = (a: { x0: number; y0: number }, b: { x0: number; y0: number }, tol: number) =>
    Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol;

  it("fits the real form, tilted as photographed, and adds nothing when OCR read every label", () => {
    const layout = fitLayout(lines)!;
    expect(layout.anchors).toBeGreaterThanOrEqual(20);
    expect(layout.added.filter((l) => /SYMBOL|SUMA|ADRES/.test(l.text))).toEqual([]);
  });
  it("places a missed KS label where OCR had it", () => {
    const ks = fitLayout(without(/KONST/))!.added.find((l) => /KON/.test(l.text))!;
    expect(ks.predicted).toBe(true);
    expect(near(ks.bbox, { x0: 1791, y0: 580 }, 8)).toBe(true);
    // The cell pass then aims at it as at a read label.
    expect(near(extractFields(without(/KONST/)).ks!.labelBox!, { x0: 1791, y0: 580 }, 8)).toBe(true);
  });
  it("finds the stub VS next to a missed label, with the value's confidence", () => {
    const r = extractFields(without(/^VARIABILN/, 100));
    expect(r.vs?.value).toBe("445577");
    expect(r.vs?.predicted).toBe(true);
    expect(r.vs?.confidence).toBe(94);
  });
  it("follows the form when the photo is smaller and shifted", () => {
    const moved = without(/KONST/).map((l) => ({
      ...l,
      bbox: { x0: l.bbox.x0 * 0.6 + 120, y0: l.bbox.y0 * 0.6 - 40, x1: l.bbox.x1 * 0.6 + 120, y1: l.bbox.y1 * 0.6 - 40 },
    }));
    const ks = fitLayout(moved)!.added.find((l) => /KON/.test(l.text))!;
    expect(near(ks.bbox, { x0: 1791 * 0.6 + 120, y0: 580 * 0.6 - 40 }, 6)).toBe(true);
  });
  it("needs real labels: no fit from text that is not the form", () => {
    expect(fitLayout([line("Faktúra 2026/114", 100, 100), line("Spolu 12,50", 100, 200)])).toBeUndefined();
  });
  it("drops a label OCR read in the wrong place", () => {
    const stray = { text: "SLOVOM", bbox: { x0: 100, y0: 1300, x1: 180, y1: 1315 }, confidence: 90 };
    const layout = fitLayout([...without(/^SLOVOM$/), stray])!;
    expect(layout.residual).toBeLessThanOrEqual(20);
  });
  it("reads the message from its boxes, where it is printed over the label", () => {
    const withMessage = lines.map((l) => (l.text === "THRRVN E" ? { ...l, text: "OBEDY", confidence: 60 } : l));
    expect(extractFields(withMessage).message?.value).toBe("OBEDY");
  });
  it("ignores box borders read as letters in the message area", () => {
    expect(extractFields(lines).message).toBeUndefined();
  });
});

describe("deskew", () => {
  // A white page with a dark band of "bars" whose rows run at `deg` clockwise.
  function zone(deg: number) {
    const w = 900;
    const h = 300;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    const t = Math.tan((deg * Math.PI) / 180);
    for (let x = 0; x < w; x++) {
      if (x % 9 < 4) continue;
      const top = Math.round(110 + (x - w / 2) * t);
      for (let y = top; y < top + 80; y++) data.fill(20, (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
    return { data, width: w, height: h };
  }
  const quad = [
    { x: 20, y: 140 },
    { x: 880, y: 140 },
    { x: 880, y: 160 },
    { x: 20, y: 160 },
  ];
  it.each([0, 1.5, -2.3, 3.8])("measures a %s degree tilt from the rows, not the scan-line corners", (deg) => {
    expect(zoneSkew(zone(deg), quad)).toBeCloseTo(deg, 1);
  });
  it("maps points the way the canvas turns", () => {
    // A quarter turn clockwise puts the top-left corner at the top-right.
    const p = rotatePoint({ x: 0, y: 0 }, 400, 200, 90);
    expect(p.x).toBeCloseTo(200);
    expect(p.y).toBeCloseTo(0);
    expect(rotatedSize(400, 200, 90)).toEqual({ w: 200, h: 400 });
  });
});
