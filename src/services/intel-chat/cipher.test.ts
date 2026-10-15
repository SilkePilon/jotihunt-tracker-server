import { describe, expect, test } from "bun:test";
import { a1z26, atbash, caesar, decodeCipher, dutchNumbers, keypad, mirrorDigits, morse, nato, plausibility, roman, vigenere } from "./cipher";

const outputs = (text: string, method?: string, key?: string) => decodeCipher(text, method, key).results.map((row) => row.output);

describe("caesar", () => {
  test("moves letters forward, keeps case and other characters", () => {
    expect(caesar("Hello, World!", 3)).toBe("Khoor, Zruog!");
    expect(caesar("xyz", 3)).toBe("abc");
  });

  test("method caesar gives all 25 shifts, the readable one first", () => {
    const { results } = decodeCipher("Khoor zruog", "caesar");
    expect(results).toHaveLength(25);
    expect(results[0]).toEqual({ method: "caesar", detail: "ROT23", output: "Hello world" });
    expect(new Set(results.map((row) => row.detail)).size).toBe(25);
  });
});

describe("atbash", () => {
  test("a↔z, b↔y", () => {
    expect(atbash("Wv elh")).toBe("De vos");
    expect(outputs("Wv elh", "atbash")).toEqual(["De vos"]);
  });
});

describe("a1z26", () => {
  test("numbers to letters, / is a word break, out of range is ?", () => {
    expect(a1z26.decode("4 5 / 22 15 19")).toBe("DE VOS");
    expect(a1z26.decode("8-5-12-12-15")).toBe("HELLO");
    expect(a1z26.decode("27 1")).toBe("?A");
  });

  test("letters to numbers", () => {
    expect(a1z26.encode("de vos")).toBe("4-5 22-15-19");
  });

  test("method a1z26 picks the direction from the input", () => {
    expect(decodeCipher("4 5 / 22 15 19", "a1z26").results).toEqual([{ method: "a1z26", detail: "getallen → letters", output: "DE VOS" }]);
    expect(decodeCipher("de vos", "a1z26").results).toEqual([{ method: "a1z26", detail: "letters → getallen", output: "4-5 22-15-19" }]);
  });
});

describe("morse", () => {
  test("decodes with / or wide spaces between words and other dot/dash glyphs", () => {
    expect(morse.decode("-.. . / ...- --- ...")).toBe("DE VOS");
    expect(morse.decode("-.. .   ...- --- ...")).toBe("DE VOS");
    expect(morse.decode("–·· · | ···– ––– ···")).toBe("DE VOS");
    expect(morse.decode("....... .-")).toBe("?A");
  });

  test("encodes letters and digits", () => {
    expect(morse.encode("SOS 1")).toBe("... --- ... / .----");
  });

  test("method morse picks the direction from the input", () => {
    expect(outputs("-.. .", "morse")).toEqual(["DE"]);
    expect(outputs("de", "morse")).toEqual(["-.. ."]);
  });
});

describe("roman", () => {
  test("numerals to numbers and back", () => {
    expect(roman.decode("MMCXXVI MMMMDCXCII")).toBe("2126 4692");
    expect(roman.decode("xiv")).toBe("14");
    expect(roman.decode("IIII")).toBeNull();
    expect(roman.encode("2126 14")).toBe("MMCXXVI XIV");
    expect(outputs("MMCXXVI", "roman")).toEqual(["2126"]);
    expect(outputs("2126", "roman")).toEqual(["MMCXXVI"]);
  });
});

describe("dutch numbers", () => {
  test.each([
    ["tweeduizend honderdzesentwintig", "2126"],
    ["vierduizend zeshonderdtweeënnegentig", "4692"],
    ["vierduizend zeshonderd tweeënnegentig", "4692"],
    ["twee-en-negentig", "92"],
    ["twee en negentig", "92"],
    ["negentienhonderd", "1900"],
    ["achttien", "18"],
    ["Eén twee drie", "1 2 3"],
    ["nul", "0"],
    ["drie miljoen tweehonderdduizend en vijf", "3200005"],
    ["Alpha: tweeduizend honderdzesentwintig vierduizend zeshonderdtweeënnegentig", "Alpha: 2126 4692"],
  ])("%s → %s", (input, expected) => {
    expect(dutchNumbers(input)).toBe(expected);
  });

  test("text without number words is null", () => {
    expect(dutchNumbers("de vos is in het bos")).toBeNull();
  });
});

describe("reverse, mirror-digits", () => {
  test("reverse turns the whole text round", () => {
    expect(outputs("sov ed", "reverse")).toEqual(["de vos"]);
  });

  test("mirror-digits replaces every digit d by 9 - d", () => {
    expect(mirrorDigits("8115 5592")).toBe("1884 4407");
    expect(outputs("8115 5592", "mirror-digits")).toEqual(["1884 4407"]);
  });
});

describe("vigenere", () => {
  test("decodes with the key, skipping non-letters in the key position", () => {
    expect(vigenere("LXFOPV EFRNHR", "lemon")).toBe("ATTACK ATDAWN");
    expect(decodeCipher("LXFOPVEFRNHR", "vigenere", "LEMON").results).toEqual([{ method: "vigenere", detail: "sleutel LEMON", output: "ATTACKATDAWN" }]);
  });

  test("without a key it is refused", () => {
    expect(() => decodeCipher("abc", "vigenere")).toThrow("Vigenère heeft een sleutel (key) nodig");
  });
});

describe("nato", () => {
  test("words to letters (Alfa and Alpha) and back", () => {
    expect(nato.decode("Delta Echo / Victor Oscar Sierra")).toBe("DE VOS");
    expect(nato.decode("alfa alpha")).toBe("AA");
    expect(nato.decode("hallo daar")).toBeNull();
    expect(nato.encode("de v")).toBe("Delta Echo / Victor");
  });
});

describe("keypad", () => {
  test("multi-tap groups to letters, 0 is a space", () => {
    expect(keypad("44 33 555 555 666")).toBe("HELLO");
    expect(keypad("3 33 0 7777")).toBe("DE S");
    expect(keypad("22222")).toBe("?");
    expect(keypad("12")).toBeNull();
  });
});

describe("plausibility", () => {
  test("an RD answer and real words beat noise", () => {
    expect(plausibility("1884 4407")).toBeGreaterThan(plausibility("8115 5592"));
    expect(plausibility("de vos is in het bos")).toBeGreaterThan(plausibility("qr ibf vf va urg obf"));
  });
});

describe("decodeCipher without method", () => {
  test("ROT13 Dutch text: the readable Caesar shift is first", () => {
    expect(decodeCipher("qr ibf vf va urg obf").results[0]).toEqual({ method: "caesar", detail: "ROT13", output: "de vos is in het bos" });
  });

  test("morse is recognised", () => {
    expect(decodeCipher("-.. . / ...- --- ...").results[0]).toMatchObject({ method: "morse", output: "DE VOS" });
  });

  test("Dutch number words that make an RD coordinate come first", () => {
    expect(decodeCipher("tweeduizend honderdzesentwintig vierduizend zeshonderdtweeënnegentig").results[0]).toMatchObject({ method: "dutch-numbers", output: "2126 4692" });
  });

  test("mirrored digits that make an RD coordinate come first", () => {
    expect(decodeCipher("8115 5592").results[0]).toMatchObject({ method: "mirror-digits", output: "1884 4407" });
  });

  test("keypad and a1z26 for digits, vigenere only with a key", () => {
    const methods = decodeCipher("44 33 555 555 666").results.map((row) => row.method);
    expect(methods).toContain("keypad");
    expect(methods).not.toContain("vigenere");
    expect(decodeCipher("44 33 555 555 666").results[0]).toMatchObject({ method: "keypad", output: "HELLO" });
    expect(decodeCipher("8 5 12 12 15").results[0]).toMatchObject({ method: "a1z26", output: "HELLO" });
    expect(decodeCipher("LXFOPVEFRNHR", undefined, "LEMON").results.map((row) => row.method)).toContain("vigenere");
  });

  test("at most 30 rows", () => {
    expect(decodeCipher("Khoor zruog").results.length).toBeLessThanOrEqual(30);
  });
});

describe("input checks", () => {
  test("empty, too long and unknown method are refused in Dutch", () => {
    expect(() => decodeCipher("  ")).toThrow("Tekst moet 1 tot 2000 tekens zijn");
    expect(() => decodeCipher("a".repeat(2001))).toThrow("Tekst moet 1 tot 2000 tekens zijn");
    expect(() => decodeCipher("abc", "rot47")).toThrow("Onbekende methode: rot47");
  });

  test("a method that does not fit the text says so", () => {
    expect(() => decodeCipher("abc", "keypad")).toThrow("Deze tekst past niet bij keypad");
  });
});
