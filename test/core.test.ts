import { describe, expect, it } from "vitest";
import { decode } from "bysquare/pay";
import { bbanToIban, isValidIban, isValidLegacyPart, mod97 } from "../src/iban";
import { mod11CheckDigit, parsePoukazBarcode } from "../src/poukaz";
import { buildBySquare, buildPaymeLink, parseAmount, toAscii } from "../src/payme";
import { extractFields, findIban, type OcrLine } from "../src/extract";
import { gridTiles, segmentCells, voteCells } from "../src/cells";
import { accented } from "../src/text";
import { flattenLight } from "../src/light";
import { consensus } from "../src/vote";
import { fitLayout } from "../src/layout";
import { rotatePoint, rotatedSize, zoneSkew } from "../src/deskew";
import { isSteady } from "../src/barcode";
import { completeKs, isKnownKsClass } from "../src/ks";
import { euroWords, parseEuroWords } from "../src/amountwords";
import realLines from "./fixtures/poukaz-real-form.lines.json";
import realLines2 from "./fixtures/poukaz-real-form-2.lines.json";

// Independent vectors: the IBAN and the payme link come from the design doc.
// The barcode vectors below are built with this code's own mod-11, so they only
// prove internal consistency, not agreement with real printed forms. The one
// exception is the worked example from the Slovenská pošta specification.

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

  // The worked example in section 3.2 of Slovenská pošta's "Technické parametre - Poštový
  // poukaz na účet a Poštový poukaz na adresu": product 36, 50 digits, check digit 3.
  it("matches the mod-11 example in the Slovenská pošta specification", () => {
    const code = "36000000190000104512020044444444440308000066660033";
    expect(mod11CheckDigit(code.slice(0, -1))).toBe(3);
    const r = parsePoukazBarcode(code)!;
    expect(r.mod11).toBe("ok");
    expect(r.variant).toBe("bban50");
    expect(r.product).toBe("36");
    expect(r.service).toBe("00");
    expect(r.iban).toBe("SK1302000000190000104512");
    expect(r.ibanValid).toBe(true);
    expect(r.vs).toBe("4444444444");
    expect(r.ks).toBe("308");
    expect(r.processing).toBe("0");
    expect(r.amountCents).toBe(6666003);
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

// A second photo of a real poukaz, after deskew, taken at an angle. Personal and payment
// data replaced as above. OCR missed the stub's ADRESÁT label, and the template placed
// it about 40 px low, on the first address line.
describe("OCR extraction on a real form taken at an angle", () => {
  const r = extractFields(realLines2 as OcrLine[]);

  it("takes the first address line under an added label as the name", () => {
    expect(r.layout?.added).toContain("ADRESÁT");
    expect(r.name?.value).toBe("ZÁ KLADNÁ ŠKOLA, VZOROVÁ CESTA 1");
  });
  it("finds both printed copies of the name, for the vote", () => {
    expect(r.nameCopies?.map((c) => c.value).sort()).toEqual(["ZÁ KLADNÁ ŠKOLA, VZOROVÁ CESTA 1", "ŠZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1,"].sort());
  });
  it("reads the amount", () => {
    expect(r.amount?.value).toBe("28,50");
    expect(r.amountWords?.euros).toBe(28);
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
  it("reads the stub amount when the rule under it reads as dots", () => {
    const r = extractFields([line("=37.", 356, 648, 404, 663), line("50.", 491, 650, 520, 664)]);
    expect(r.amount?.value).toBe("37,50");
  });
  it("finds the cents under a cent label, for the amount in words", () => {
    const r = extractFields([line("cent", 506, 618, 535, 629), line("50", 491, 650, 520, 664)]);
    expect(r.centsBelowLabel?.value).toBe("50");
  });
  it("does not take half of a number cut by a form rule", () => {
    // VS 112613 printed on the rule between the VS and SS rows: two short fragments.
    const label = line("ŠPECIFICKÝ SYMBOL", 60, 762, 223, 776);
    expect(extractFields([label, line("1120719", 281, 762, 370, 771)]).ss?.value).toBe("");
    expect(extractFields([label, line("112613", 281, 756, 370, 776)]).ss?.value).toBe("112613");
  });
  it("does not take a scrap of the ADRESÁT label as the name", () => {
    // OCR read the label and a scrap of it just under, above the real line (seen on a 4K frame).
    const r = extractFields([
      line("ADRESÁT", 37, 932, 125, 950),
      line("SÁT", 92, 943, 126, 960),
      line("ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1", 36, 962, 520, 990),
    ]);
    expect(r.name?.value).toBe("ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1");
  });
  it("does not take a short run as KS: it prints all 4 digits", () => {
    const r = extractFields([line("KONŠT. SYMBOL 1", 100, 100)]);
    expect(r.ks?.value).toBe("");
    // The cell pass still gets the label to aim at.
    expect(r.ks?.labelBox).toBeDefined();
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
    // The shape's own proportions, without the margin: a narrow one is a 1.
    expect(tiles[0].aspect).toBeCloseTo(15 / 30);
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
  it("drops a shape much shorter than the digits, a piece of a label or box", () => {
    const img = page(200, 60, [
      [40, 15, 55, 45],
      [80, 30, 92, 44],
      [120, 15, 135, 45],
    ]);
    expect(segmentCells(img, 0.5).map((t) => t.x)).toEqual([40, 120]);
  });
  it("returns nothing for an empty crop", () => {
    expect(segmentCells(page(100, 40, []), 0.5)).toEqual([]);
  });
});

// Readings of one printed name line: the stub and the middle copy, each from the page OCR
// and from its own crop. The mistakes are the ones seen on real photos, on fake text.
describe("name vote", () => {
  const vote = (rs: [string, number][]) => consensus(rs.map(([text, confidence]) => ({ text, confidence })));
  it("fixes a letter no single reading got right", () => {
    // Seen: "SF OJENÁ" on the stub, "ŠSPOJENÁ" and '"SPOJENÁ' in the middle copy.
    const r = vote([
      ["ZF KLADNÁ ŠKOLA, VZOROVÁ CESTA 1", 90],
      ["[5 KLADNA ŠKOLA, VZOROVA CESTA 1,", 81],
      ["ŠZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1,", 83],
      ['"ZÁKLADNÁ „ŠKOLA, VZOROVÁ CESTA 1,', 87],
    ]);
    expect(r?.text).toBe("ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1,");
  });
  it("keeps an accent that one reading dropped", () => {
    const r = vote([
      ["ZAKLADNA SKOLA, VZOROVA CESTA 1", 93],
      ["ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1,", 93],
      ['"ZÁKLADNÁ OVCE VIZOROVÁ CESTA 1,', 50],
      ["", 0],
    ]);
    expect(r?.text).toBe("ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1,");
  });
  it("drops an accent that only a weak reading has", () => {
    expect(vote([["SKOLA", 90], ["SKOLA", 90], ["ŠKOLA", 60]])?.text).toBe("SKOLA");
  });
  it("does not cut the name short when some readings stop early", () => {
    // Seen: the stub line split by OCR, and its crop read only to "MARKU".
    const r = vote([
      ["ZÁKLADNÁ ŠKOLA, VZOR!", 78],
      ["ZÁKLADNÁ ŠKOLA, VZO", 94],
      ["ZÁKLADNÁ Hy VZOROVÁ CESTA 1,", 66],
    ]);
    expect(r?.text).toBe("ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1,");
  });
  it("keeps a first letter the cut stub lost", () => {
    const r = vote([
      ["ÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1", 92],
      ["AKLADNA SKOLA, VZOROVA CESTA 1", 90],
      ["ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1,", 88],
      ["ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1", 85],
    ]);
    expect(r?.text.replace(/,$/, "")).toBe("ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1");
  });
  it("leaves out readings of another line", () => {
    const r = vote([["ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1", 90], ["| ZASA doom", 28]]);
    expect(r).toEqual({ text: "ZÁKLADNÁ ŠKOLA, VZOROVÁ CESTA 1", used: 1 });
  });
});

describe("gridTiles", () => {
  // A row of 12 boxes, 40 px wide and 60 tall, at y 20-80, as the message prints them.
  const cells = Array.from({ length: 12 }, (_, i) => ({ x0: 20 + i * 40, y0: 20, x1: 60 + i * 40, y1: 80 }));
  // Letters 26 px tall stand on the rule at y 66; the grid's fit is 8 px off to the left.
  const at = (box: number, dx = 0) => 20 + box * 40 + 12 + 8 + dx;
  const img = page(540, 100, [
    [at(0), 40, at(0) + 14, 66], // a capital
    [at(1), 40, at(1) + 14, 66], // a capital with a caron
    [at(1) + 4, 33, at(1) + 10, 37],
    [at(2), 52, at(2) + 12, 56], // a hyphen
    [at(3), 48, at(3) + 14, 66], // a lowercase letter
    [at(11), 40, at(11) + 14, 66], // the last letter, crossed by the column's rule
    [0, 66, 540, 68], // the rule under the row
    [at(11) + 10, 0, at(11) + 13, 100], // the column's rule
    [at(7) + 2, 50, at(7) + 4, 52], // dust in an empty box
  ]);
  const tiles = gridTiles(img, cells, 0.5);
  it("puts each character in its box, empty boxes as null", () => {
    expect(tiles.map((t) => (t ? "x" : "_")).join("")).toBe("xxxx_______x");
  });
  it("keeps a caron with its letter", () => {
    expect(tiles[1]?.marks).toBe(1);
    expect(tiles[0]?.marks).toBe(0);
  });
  it("keeps a letter standing on a rule, without the rule", () => {
    expect(tiles[0]?.mainHeight).toBe(26);
  });
  it("tells a capital from a lowercase letter by height", () => {
    expect(tiles[3]!.mainHeight).toBeLessThan(tiles[0]!.mainHeight * 0.8);
  });
  it("keeps the hyphen as a flat mark", () => {
    expect(tiles[2]!.aspect).toBeGreaterThan(2);
  });
});

describe("accents from marks", () => {
  it("puts an acute on a vowel and a caron on a consonant", () => {
    expect(accented("e", 1)).toBe("é");
    expect(accented("Y", 1)).toBe("Ý");
    expect(accented("C", 1)).toBe("Č");
    expect(accented("s", 1)).toBe("š");
    expect(accented("a", 2)).toBe("ä");
    expect(accented("M", 1)).toBe("M");
  });
});

describe("voteCells", () => {
  const reading = (s: string, at = 0) => ({ cells: [...s].map((ch, i) => ({ center: at + i * 50, inkHeight: 40, ch: ch === "?" ? null : ch })) });
  it("takes the digit most thresholds read", () => {
    // Seen: 0.4 read 112513 at 88 for a printed 112613; 0.5 and 0.6 read the 6.
    expect(voteCells([reading("112613"), reading("112513"), reading("112613")]).join("")).toBe("112613");
  });
  it("leaves a place unreadable when two thresholds disagree", () => {
    expect(voteCells([reading("112613"), reading("112513")])).toEqual(["1", "1", "2", null, "1", "3"]);
  });
  it("fills a place one threshold could not read", () => {
    expect(voteCells([reading("??2613"), reading("112613")]).join("")).toBe("112613");
  });
  it("drops a shape only one of three thresholds saw", () => {
    const speck = { cells: [...reading("0179").cells, { center: 260, inkHeight: 40, ch: "1" }] };
    expect(voteCells([reading("0179"), speck, reading("0179")]).join("")).toBe("0179");
  });
  it("matches characters that moved a few pixels between thresholds", () => {
    expect(voteCells([reading("0179", 0), reading("0179", 6), reading("0479", 3)]).join("")).toBe("0179");
  });
});

describe("flattenLight", () => {
  it("makes a shadowed page separable at one threshold", () => {
    // Paper from 230 on the left to 90 in the shadow on the right; ink at 40% of the paper.
    const w = 400;
    const h = 100;
    const paper = (x: number) => 230 - (140 * x) / w;
    const isInk = (x: number, y: number) => x % 40 >= 17 && x % 40 < 23 && y >= 35 && y < 65;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = isInk(x, y) ? paper(x) * 0.4 : paper(x);
        data.fill(v, (y * w + x) * 4, (y * w + x) * 4 + 3);
        data[(y * w + x) * 4 + 3] = 255;
      }
    }
    // Before: the shaded paper is darker than the ink in the light.
    expect(paper(w - 1)).toBeLessThan(paper(0) * 0.4 + 10);
    flattenLight({ data, width: w, height: h });
    let maxInk = 0;
    let minPaper = 255;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = data[(y * w + x) * 4];
        if (isInk(x, y)) maxInk = Math.max(maxInk, v);
        else minPaper = Math.min(minPaper, v);
      }
    }
    expect(maxInk).toBeLessThan(130);
    expect(minPaper).toBeGreaterThan(220);
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

describe("hold-still check", () => {
  const q = (x: number, y: number, w: number) => [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + 40 },
    { x, y: y + 40 },
  ];
  it("accepts the code at the same place and size", () => {
    expect(isSteady(q(300, 900, 600), q(305, 903, 604), 1080)).toBe(true);
  });
  it("rejects a phone still moving across", () => {
    expect(isSteady(q(300, 900, 600), q(340, 900, 600), 1080)).toBe(false);
  });
  it("rejects a phone moving closer", () => {
    expect(isSteady(q(300, 900, 600), q(280, 900, 650), 1080)).toBe(false);
  });
});
