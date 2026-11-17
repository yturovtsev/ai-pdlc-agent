// Видимая ширина и перенос текста без зависимости от жизненного цикла терминала.
// Emoji, которые терминал по умолчанию рисует в две колонки, вне блоков U+1F300 и далее.
const WIDE_BMP: [number, number][] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
];
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];
const ZERO: [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a], [0x064b, 0x065f], [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0x1f3fb, 0x1f3ff], [0xe0000, 0xe0fff],
];
const within = (cp: number, ranges: [number, number][]) => ranges.some(([a, b]) => cp >= a && cp <= b);

/** Ширина символа в колонках терминала: широкие CJK и emoji — 2, комбинируемые и управляющие — 0. */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (within(cp, ZERO)) return 0;
  return within(cp, WIDE) || within(cp, WIDE_BMP) ? 2 : 1;
}

/** Видимая ширина строки без ANSI-последовательностей и ссылок OSC 8. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '')) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Перенос строки по видимой ширине: по словам, слово длиннее ширины режется. */
export function wrapText(line: string, width: number): string[] {
  if (textWidth(line) <= width) return [line];
  const out: string[] = [];
  let cur = '';
  let w = 0;
  const flush = () => {
    out.push(cur.trimEnd());
    cur = '';
    w = 0;
  };
  for (const token of line.split(/(\s+)/)) {
    if (!token) continue;
    const tw = textWidth(token);
    if (/^\s/.test(token)) {
      // Пробелы на переносе пропадают, отступ в начале абзаца остаётся.
      if (w + tw <= width && (cur || !out.length)) {
        cur += token;
        w += tw;
      } else if (cur) flush();
      continue;
    }
    if (w + tw > width && cur) flush();
    if (tw <= width) {
      cur += token;
      w += tw;
      continue;
    }
    for (const ch of token) {
      const cw = charWidth(ch.codePointAt(0)!);
      if (w + cw > width) flush();
      cur += ch;
      w += cw;
    }
  }
  if (cur.trim()) flush();
  return out;
}
