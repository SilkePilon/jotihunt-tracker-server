import { ToolInputError } from "./tools/context";

/** decodeCipher methods (contract) */
export const CIPHER_METHODS = ["caesar", "atbash", "a1z26", "morse", "roman", "dutch-numbers", "reverse", "mirror-digits", "vigenere", "nato", "keypad"] as const;
export type CipherMethod = (typeof CIPHER_METHODS)[number];

export interface CipherRow {
  method: CipherMethod;
  detail?: string;
  output: string;
}

const MAX_TEXT = 2000;
const MAX_ROWS = 30;
const A = "A".charCodeAt(0);
const a = "a".charCodeAt(0);

/** Map every letter (case kept) through `letter` (0-25 → 0-25); other characters stay */
function mapLetters(text: string, letter: (index: number, position: number) => number): string {
  let position = 0;
  return text.replace(/[a-z]/gi, (char) => {
    const base = char <= "Z" ? A : a;
    return String.fromCharCode(base + (((letter(char.charCodeAt(0) - base, position++) % 26) + 26) % 26));
  });
}

/** Every letter moved `shift` places forward in the alphabet (ROT-n) */
export const caesar = (text: string, shift: number) => mapLetters(text, (index) => index + shift);

export const atbash = (text: string) => mapLetters(text, (index) => 25 - index);

/** Vigenère decoding: every letter moved back by the next key letter (only letters use up the key) */
export function vigenere(text: string, key: string): string {
  const shifts = [...key.toUpperCase().replace(/[^A-Z]/g, "")].map((char) => char.charCodeAt(0) - A);
  if (shifts.length === 0) throw new ToolInputError("Vigenère heeft een sleutel (key) nodig");
  return mapLetters(text, (index, position) => index - shifts[position % shifts.length]);
}

export const mirrorDigits = (text: string) => text.replace(/\d/g, (digit) => String(9 - Number(digit)));

/** Words split on "/", "|" or two or more spaces */
const splitWords = (text: string) => text.split(/\s*[/|]\s*|\s{2,}/).filter((word) => word.trim() !== "");

export const a1z26 = {
  /** "8-5-12-12-15 / ..." → "HELLO ..."; null when the text is not just numbers */
  decode(text: string): string | null {
    if (!/^[\d\s,.;:\-/|]+$/.test(text) || !/\d/.test(text)) return null;
    return splitWords(text)
      .map((word) =>
        (word.match(/\d+/g) ?? [])
          .map((number) => {
            const value = Number(number);
            return value >= 1 && value <= 26 ? String.fromCharCode(A + value - 1) : "?";
          })
          .join(""),
      )
      .join(" ");
  },
  /** "de vos" → "4-5 22-15-19"; null without letters */
  encode(text: string): string | null {
    const words = text.split(/\s+/).map((word) => [...word.toUpperCase().replace(/[^A-Z]/g, "")].map((char) => char.charCodeAt(0) - A + 1).join("-"));
    const filled = words.filter(Boolean);
    return filled.length > 0 ? filled.join(" ") : null;
  },
};

const MORSE: Record<string, string> = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  "0": "-----",
  "1": ".----",
  "2": "..---",
  "3": "...--",
  "4": "....-",
  "5": ".....",
  "6": "-....",
  "7": "--...",
  "8": "---..",
  "9": "----.",
  ".": ".-.-.-",
  ",": "--..--",
  "?": "..--..",
  "!": "-.-.--",
  ":": "---...",
  "'": ".----.",
  "-": "-....-",
  "@": ".--.-.",
};
const FROM_MORSE = new Map(Object.entries(MORSE).map(([char, code]) => [code, char]));

export const morse = {
  /** Dots and dashes (also ·, •, –, —, _) with spaces between letters and "/", "|" or wide spaces between words; null otherwise */
  decode(text: string): string | null {
    const normal = text.replace(/[·•∙]/g, ".").replace(/[–—_−‒]/g, "-");
    if (!/^[.\-\s/|]+$/.test(normal) || !/[.-]/.test(normal)) return null;
    return splitWords(normal)
      .map((word) =>
        word
          .trim()
          .split(/\s+/)
          .map((code) => FROM_MORSE.get(code) ?? "?")
          .join(""),
      )
      .join(" ");
  },
  /** Letters and digits to morse, " / " between words; null when nothing can be encoded */
  encode(text: string): string | null {
    const words = text
      .toUpperCase()
      .split(/\s+/)
      .map((word) => [...word].flatMap((char) => (MORSE[char] ? [MORSE[char]] : [])).join(" "))
      .filter(Boolean);
    return words.length > 0 ? words.join(" / ") : null;
  },
};

const ROMAN: [string, number][] = [
  ["CM", 900],
  ["D", 500],
  ["CD", 400],
  ["C", 100],
  ["XC", 90],
  ["L", 50],
  ["XL", 40],
  ["X", 10],
  ["IX", 9],
  ["V", 5],
  ["IV", 4],
  ["I", 1],
];
const ROMAN_VALUE: Record<string, number> = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };

function toRoman(value: number): string {
  let rest = value % 1000;
  let out = "M".repeat(Math.floor(value / 1000));
  for (const [symbol, amount] of ROMAN) {
    while (rest >= amount) {
      out += symbol;
      rest -= amount;
    }
  }
  return out;
}

function fromRoman(token: string): number | null {
  const upper = token.toUpperCase();
  if (!/^[MDCLXVI]+$/.test(upper)) return null;
  let value = 0;
  for (let i = 0; i < upper.length; i++) {
    const current = ROMAN_VALUE[upper[i]];
    const next = ROMAN_VALUE[upper[i + 1]] ?? 0;
    value += current < next ? -current : current;
  }
  // Only the canonical spelling counts ("IIII" is not 4)
  return value > 0 && toRoman(value) === upper ? value : null;
}

export const roman = {
  /** "MMCXXVI XIV" → "2126 14"; null unless every word is a valid numeral */
  decode(text: string): string | null {
    const tokens = text.split(/[\s,;/|]+/).filter(Boolean);
    const values = tokens.map(fromRoman);
    return tokens.length > 0 && values.every((value) => value !== null) ? values.join(" ") : null;
  },
  /** "2126 14" → "MMCXXVI XIV" (1-9999); null unless every word is such a number */
  encode(text: string): string | null {
    const tokens = text.split(/[\s,;/|]+/).filter(Boolean);
    if (tokens.length === 0 || !tokens.every((token) => /^\d{1,4}$/.test(token) && Number(token) > 0)) return null;
    return tokens.map((token) => toRoman(Number(token))).join(" ");
  },
};

// --- Dutch number words -----------------------------------------------------------------------------------------

const UNITS: Record<string, number> = { een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9 };
const TEENS: Record<string, number> = { tien: 10, elf: 11, twaalf: 12, dertien: 13, veertien: 14, vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19 };
const TENS: Record<string, number> = { twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90 };

/** 1-99: "zes", "zestien", "zestig", "zesentwintig" */
function below100(s: string): number | null {
  const simple = UNITS[s] ?? TEENS[s] ?? TENS[s];
  if (simple !== undefined) return simple;
  for (const [unit, value] of Object.entries(UNITS)) {
    if (s.startsWith(`${unit}en`) && TENS[s.slice(unit.length + 2)] !== undefined) return value + TENS[s.slice(unit.length + 2)];
  }
  return null;
}

/** The part after "honderd"/"duizend"/"miljoen": empty = 0, an "en" in front is allowed ("duizend en vijf") */
function rest(s: string, below: (s: string) => number | null): number | null {
  if (s === "") return 0;
  return below(s) ?? (s.startsWith("en") ? below(s.slice(2)) : null);
}

/** Split on a multiplier word: left (empty = 1) × multiplier + right */
function withMultiplier(s: string, word: string, multiplier: number, left: (s: string) => number | null, right: (s: string) => number | null): number | null {
  const at = s.indexOf(word);
  if (at < 0) return right(s);
  const head = at === 0 ? 1 : left(s.slice(0, at));
  const tail = rest(s.slice(at + word.length), right);
  return head === null || tail === null ? null : head * multiplier + tail;
}

const below1000 = (s: string) => withMultiplier(s, "honderd", 100, below100, below100);
const belowMillion = (s: string) => withMultiplier(s, "duizend", 1000, below1000, below1000);
const compound = (s: string): number | null => (s === "nul" ? 0 : withMultiplier(s, "miljoen", 1_000_000, below1000, belowMillion));

const normaliseWord = (word: string) => word.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/-/g, "");

/**
 * Dutch number words to digits, the rest of the text kept: "tweeduizend honderdzesentwintig" → "2126". Words that
 * together make one number (with spaces, hyphens, "en") are joined; null when the text holds no number word.
 */
export function dutchNumbers(text: string): string | null {
  const pieces = text.match(/[\p{L}-]+|[^\p{L}-]+/gu) ?? [];
  const out: string[] = [];
  let found = false;
  for (let i = 0; i < pieces.length;) {
    if (!/\p{L}/u.test(pieces[i])) {
      out.push(pieces[i++]);
      continue;
    }
    // The longest run of words (only whitespace between them) that reads as one number
    let best: { end: number; value: number } | null = null;
    let joined = "";
    for (let j = i; j < pieces.length && j < i + 16; j += 2) {
      joined += normaliseWord(pieces[j]);
      const value = compound(joined);
      if (value !== null) best = { end: j, value };
      if (j + 1 >= pieces.length || !/^\s+$/.test(pieces[j + 1])) break;
    }
    if (best) {
      out.push(String(best.value));
      found = true;
      i = best.end + 1;
    } else {
      out.push(pieces[i++]);
    }
  }
  return found ? out.join("") : null;
}

// --- NATO, keypad -----------------------------------------------------------------------------------------------

const NATO_WORDS = [
  "Alfa",
  "Bravo",
  "Charlie",
  "Delta",
  "Echo",
  "Foxtrot",
  "Golf",
  "Hotel",
  "India",
  "Juliett",
  "Kilo",
  "Lima",
  "Mike",
  "November",
  "Oscar",
  "Papa",
  "Quebec",
  "Romeo",
  "Sierra",
  "Tango",
  "Uniform",
  "Victor",
  "Whiskey",
  "Xray",
  "Yankee",
  "Zulu",
];
const FROM_NATO = new Map<string, string>([...NATO_WORDS.map((word) => [word.toLowerCase(), word[0]] as [string, string]), ["alpha", "A"], ["juliet", "J"], ["whisky", "W"]]);

export const nato = {
  /** "Delta Echo / Victor" → "DE V"; null unless at least half of the words are NATO words */
  decode(text: string): string | null {
    const tokens = text.match(/[a-z-]+|[/|]/gi) ?? [];
    const words = tokens.filter((token) => !/^[/|]$/.test(token));
    const known = words.filter((word) => FROM_NATO.has(normaliseWord(word))).length;
    if (known === 0 || known * 2 < words.length) return null;
    return tokens
      .map((token) => (/^[/|]$/.test(token) ? " " : (FROM_NATO.get(normaliseWord(token)) ?? "?")))
      .join("")
      .trim();
  },
  /** "de v" → "Delta Echo / Victor"; null without letters */
  encode(text: string): string | null {
    const words = text
      .toUpperCase()
      .split(/\s+/)
      .map((word) => [...word.replace(/[^A-Z]/g, "")].map((char) => NATO_WORDS[char.charCodeAt(0) - A]).join(" "))
      .filter(Boolean);
    return words.length > 0 ? words.join(" / ") : null;
  },
};

const KEYPAD: Record<string, string> = { "2": "ABC", "3": "DEF", "4": "GHI", "5": "JKL", "6": "MNO", "7": "PQRS", "8": "TUV", "9": "WXYZ" };

/** T9 multi-tap: "44 33 555" → "HEL" (0 = space, "/" = space, too many presses = ?); null unless every group is one repeated key 0/2-9 */
export function keypad(text: string): string | null {
  if (!/^[\d\s,.\-/|]+$/.test(text)) return null;
  const tokens = text.match(/\d+|[/|]/g) ?? [];
  if (tokens.length === 0) return null;
  let out = "";
  for (const token of tokens) {
    if (token === "/" || token === "|" || /^0+$/.test(token)) {
      out += " ";
      continue;
    }
    if (!/^([2-9])\1*$/.test(token)) return null;
    out += KEYPAD[token[0]][token.length - 1] ?? "?";
  }
  return out;
}

// --- Ranking ----------------------------------------------------------------------------------------------------

/** Common Dutch and English words plus Jotihunt words: a hit makes an output more likely to be the plain text */
const WORDS = new Set(
  `de het een en van in is op te dat die niet zijn met voor er aan als bij of om maar dan ook naar nog wel uit door over tot je ik we wij jij hij zij ze
  u kan zal moet wordt werd waar wat wie hoe hier daar dit deze zo al was heb heeft hebben ga gaat gaan kom komt nu ja nee geen meer veel goed
  vos vossen bos hint hunt hunter team jotihunt scouting scouts groep kerk molen toren water brug straat weg plein station school kasteel park
  noord zuid oost west links rechts bij achter naast boven onder huis dorp stad punt antwoord code geheim zoek vind loop rennen links
  alpha bravo charlie delta echo foxtrot golf hotel oscar arnhem nijmegen apeldoorn ede gelderland schotland brave
  the and of to it that for you was on are with as be at this have from or by not but what all were when we there can an your which their
  if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than
  first been its who now people my made over did down only way find use may water long little very after words called just where most know
  hello world attack dawn yes go here`.split(/\s+/),
);

const LETTER_FREQ: Record<string, number> = {
  e: 18.9,
  n: 10,
  a: 7.5,
  t: 6.8,
  i: 6.5,
  r: 6.4,
  o: 6.1,
  d: 5.9,
  s: 3.7,
  l: 3.6,
  g: 3.4,
  v: 2.9,
  h: 2.4,
  k: 2.3,
  m: 2.2,
  u: 2,
  b: 1.6,
  p: 1.6,
  w: 1.5,
  j: 1.5,
  z: 1.4,
  c: 1.2,
  f: 0.8,
  x: 0.04,
  y: 0.04,
  q: 0.01,
};

/** A Jotihunt RD answer in Gelderland ("XXXX YYYY" in hectometres or "XXXXXX YYYYYY" in metres) */
function hasRdAnswer(text: string): boolean {
  for (const match of text.matchAll(/(?<!\d)(\d{4}|\d{6})\s*[,;/]?\s*(\d{4}|\d{6})(?!\d)/g)) {
    if (match[1].length !== match[2].length) continue;
    const scale = match[1].length === 4 ? 1 : 0.01;
    const x = Number(match[1]) * scale;
    const y = Number(match[2]) * scale;
    if (x >= 1300 && x <= 2600 && y >= 4100 && y <= 5200) return true;
  }
  return false;
}

/** How likely an output is the real plain text: RD answer, known words, Dutch letter frequencies; unknown symbols (?) count against */
export function plausibility(output: string): number {
  let score = hasRdAnswer(output) ? 100 : 0;
  const words = (output.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => word.length >= 2);
  if (words.length > 0) {
    const hits = words.filter((word) => WORDS.has(word)).length;
    score += (hits / words.length) * 40 + Math.min(hits, 5) * 2;
  }
  const letters = output.toLowerCase().match(/[a-z]/g) ?? [];
  if (letters.length > 0) score += (letters.reduce((sum, letter) => sum + Math.log10(LETTER_FREQ[letter]), 0) / letters.length + 2) * 5;
  score -= Math.min(50, (output.match(/\?/g) ?? []).length * 10);
  return score;
}

// --- decodeCipher -----------------------------------------------------------------------------------------------

/** Both directions of a two-way method: decoding when the text fits, else (asked explicitly) encoding */
function twoWay(
  method: CipherMethod,
  text: string,
  auto: boolean,
  codec: { decode: (text: string) => string | null; encode: (text: string) => string | null },
  details: [string, string],
): CipherRow[] {
  const decoded = codec.decode(text);
  if (decoded !== null) return [{ method, detail: details[0], output: decoded }];
  const encoded = auto ? null : codec.encode(text);
  return encoded !== null ? [{ method, detail: details[1], output: encoded }] : [];
}

const hasLetters = (text: string) => /[a-z]/i.test(text);

function rowsFor(method: CipherMethod, text: string, key: string | undefined, auto: boolean): CipherRow[] {
  const one = (output: string | null, detail?: string): CipherRow[] => (output === null ? [] : [{ method, ...(detail ? { detail } : {}), output }]);
  switch (method) {
    case "caesar":
      return hasLetters(text) ? Array.from({ length: 25 }, (_, i) => ({ method, detail: `ROT${i + 1}`, output: caesar(text, i + 1) })) : [];
    case "atbash":
      return hasLetters(text) ? one(atbash(text)) : [];
    case "a1z26":
      return twoWay(method, text, auto, a1z26, ["getallen → letters", "letters → getallen"]);
    case "morse":
      return twoWay(method, text, auto, morse, ["morse → tekst", "tekst → morse"]);
    case "roman":
      return twoWay(method, text, auto, roman, ["romeins → getallen", "getallen → romeins"]);
    case "dutch-numbers":
      return one(dutchNumbers(text));
    case "reverse":
      return one([...text].reverse().join(""));
    case "mirror-digits":
      return /\d/.test(text) ? one(mirrorDigits(text), "cijfer → 9 - cijfer") : [];
    case "vigenere":
      if (!key?.trim()) throw new ToolInputError("Vigenère heeft een sleutel (key) nodig");
      return hasLetters(text) ? one(vigenere(text, key), `sleutel ${key.trim().toUpperCase()}`) : [];
    case "nato":
      return twoWay(method, text, auto, nato, ["NATO → letters", "letters → NATO"]);
    case "keypad":
      return one(keypad(text), "T9 multi-tap");
  }
}

/**
 * Decode a text with one method, or (without method) with every method that fits, best first by plausibility. At most
 * 30 rows. Deterministic, no AI.
 */
export function decodeCipher(text: string, method?: string, key?: string): { results: CipherRow[] } {
  const input = String(text ?? "").trim();
  if (!input || input.length > MAX_TEXT) throw new ToolInputError("Tekst moet 1 tot 2000 tekens zijn");
  const wanted = method === undefined || method === null || String(method).trim() === "" ? null : String(method).trim().toLowerCase();
  if (wanted !== null && !(CIPHER_METHODS as readonly string[]).includes(wanted)) throw new ToolInputError(`Onbekende methode: ${String(method).slice(0, 40)}`);
  const keyText = key === undefined || key === null ? undefined : String(key);
  let rows: CipherRow[];
  if (wanted !== null) {
    rows = rowsFor(wanted as CipherMethod, input, keyText, false);
    if (rows.length === 0) throw new ToolInputError(`Deze tekst past niet bij ${wanted}`);
  } else {
    rows = CIPHER_METHODS.filter((name) => name !== "vigenere" || keyText?.trim()).flatMap((name) => rowsFor(name, input, keyText, true));
  }
  const ranked = rows.map((row, index) => ({ row, index, score: plausibility(row.output) })).sort((x, y) => y.score - x.score || x.index - y.index);
  return { results: ranked.slice(0, MAX_ROWS).map(({ row }) => row) };
}
