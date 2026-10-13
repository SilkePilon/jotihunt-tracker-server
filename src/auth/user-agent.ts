const BROWSERS: [RegExp, string][] = [
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Edg(A|iOS)?\//, "Edge"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/OPR\//, "Opera"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/Android/, "Android"],
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

/** Short Dutch label for a session or passkey, e.g. "Firefox op Linux". */
export function deviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return "Onbekend apparaat";
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (!browser || !system) return "Onbekend apparaat";
  return `${browser} op ${system}`;
}
