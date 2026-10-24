// Экран лога: где на экране стоят строки размышлений, раскрытие и сворачивание их по клику.
// Содержимое экрана у терминала не прочитать, поэтому модель считает вертикальное движение
// курсора по всему выводу в stdout и stderr, а абсолютную строку курсора спрашивает у терминала
// в момент клика (DSR). Без start() всё — no-op, а write потоков не подменяется.

const ESC = '\x1b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const DSR = `${ESC}[6n`;
const MAX_ENTRIES = 200;
const REPLY_MS = 500;
const QUERIES = 3;

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

/** Видимая ширина строки без ANSI-последовательностей. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) w += charWidth(ch.codePointAt(0)!);
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

type Mode = 'text' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'charset';

/**
 * Вертикальное движение курсора по выводу. Расстояние «строка → курсор» растёт на 1 с каждым
 * переводом строки — и когда курсор опускается, и когда прокручивается содержимое, поэтому
 * абсолютная строка курсора не нужна до клика. Внутри ESC7…ESC8 движение не учитывается: так
 * пишут панель и сам экран. Абсолютное позиционирование вне них — сброс (epoch растёт).
 */
export class CursorModel {
  moved = 0;
  col = 0;
  epoch = 0;
  private saved: { moved: number; col: number } | undefined;
  private inSave = false;
  private mode: Mode = 'text';
  private params = '';

  feed(s: string, columns: number): void {
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (this.mode === 'text') this.text(cp, columns);
      else if (this.mode === 'esc') this.escape(ch);
      else if (this.mode === 'csi') this.csi(ch, cp, columns);
      else if (this.mode === 'osc') this.mode = cp === 0x07 ? 'text' : cp === 0x1b ? 'osc-esc' : 'osc';
      else this.mode = 'text';
    }
  }

  /** Сдвиг, который экран сделал сам (мимо разбора). */
  shift(delta: number): void {
    this.moved += delta;
    if (this.saved) this.saved.moved += delta;
  }

  private text(cp: number, columns: number): void {
    if (cp === 0x1b) {
      this.mode = 'esc';
      return;
    }
    if (this.inSave) return;
    // \n печатается как \r\n: ONLCR остаётся включённым и в raw-режиме ввода.
    if (cp === 0x0a) {
      this.moved++;
      this.col = 0;
    } else if (cp === 0x0d) this.col = 0;
    else if (cp === 0x08) this.col = Math.max(0, Math.min(this.col, columns - 1) - 1);
    else if (cp === 0x09) this.col = Math.min(columns - 1, (Math.floor(this.col / 8) + 1) * 8);
    else {
      const w = charWidth(cp);
      if (!w) return;
      // Отложенный перенос: символ в последней колонке переносит только следующий.
      if (this.col + w > columns) {
        this.moved++;
        this.col = 0;
      }
      this.col += w;
    }
  }

  private escape(ch: string): void {
    this.mode = 'text';
    if (ch === '[') {
      this.mode = 'csi';
      this.params = '';
    } else if (ch === ']') this.mode = 'osc';
    else if ('()*+'.includes(ch)) this.mode = 'charset';
    else if (ch === '7') {
      this.saved = { moved: this.moved, col: this.col };
      this.inSave = true;
    } else if (ch === '8') {
      if (this.saved) ({ moved: this.moved, col: this.col } = this.saved);
      this.inSave = false;
    } else if (this.inSave) return;
    else if (ch === 'E') {
      this.moved++;
      this.col = 0;
    } else if (ch === 'D') this.moved++;
    else if (ch === 'M' || ch === 'c') this.epoch++;
  }

  private csi(ch: string, cp: number, columns: number): void {
    if (cp >= 0x20 && cp <= 0x3f) {
      this.params += ch;
      return;
    }
    this.mode = 'text';
    if (cp < 0x40 || cp > 0x7e || this.inSave || /^[?<>=]/.test(this.params)) return;
    const n = Math.max(1, Number(this.params.split(';')[0]) || 1);
    switch (ch) {
      case 'A':
        this.moved -= n;
        break;
      case 'F':
        this.moved -= n;
        this.col = 0;
        break;
      case 'B':
        this.moved += n;
        break;
      case 'E':
        this.moved += n;
        this.col = 0;
        break;
      case 'C':
        this.col = Math.min(columns - 1, this.col + n);
        break;
      case 'D':
        this.col = Math.max(0, Math.min(this.col, columns - 1) - n);
        break;
      case 'G':
        this.col = Math.min(columns - 1, n - 1);
        break;
      case 'J':
        if (this.params === '2' || this.params === '3') this.epoch++;
        break;
      case 'H':
      case 'f':
      case 'r':
      case 'S':
      case 'T':
      case 'L':
      case 'M':
        this.epoch++;
        break;
    }
  }
}

/** Как строку размышления рисует лог: log.ts знает префиксы и цвета, экран — где она стоит. */
export interface ThinkingView {
  /** Строка размышления целиком, как её печатает лог: свёрнутая (▸) или раскрытая (▾). */
  header(open: boolean): string;
  /** Строки текста под ширину окна: каждая уже columns, чтобы терминал не переносил её сам. */
  body(columns: number): string[];
  /** Последняя строка обрезанного текста: сколько строк не показано. */
  more(hidden: number, columns: number): string;
}

export interface ScreenStream {
  isTTY?: boolean;
  rows?: number;
  columns?: number;
  // any: у потоков Node перегрузки write с кодировкой и callback.
  write(chunk: string | Uint8Array, ...rest: any[]): boolean;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

/** Положение курсора перед строкой размышления: по нему запись встаёт на экран после вывода. */
export interface Mark {
  base: number;
  epoch: number;
}

interface Entry {
  view: ThinkingView;
  /** moved перед выводом строки: расстояние от её верха до курсора — moved − base. */
  base: number;
  headerRows: number;
  /** Строк раскрытого текста под строкой. */
  open?: number;
}

type Write = ScreenStream['write'];
type Position = { moved: number; col: number; epoch: number };
type Target = { e: Entry; expand: boolean };

class Screen {
  private on = false;
  private out: ScreenStream | undefined;
  private rawWrite: Write | undefined;
  private model = new CursorModel();
  private entries: Entry[] = [];
  private epoch = 0;
  private unhook: (() => void)[] = [];
  private logBottom: () => number | undefined = () => undefined;
  private pending: (Position & { y: number; tries: number; timer: ReturnType<typeof setTimeout>; target?: Target }) | undefined;
  private readonly onResize = () => this.forget();

  /** out — терминал лога, err — stderr, если он тот же терминал; logBottom — нижняя строка области лога. */
  start(o: { enabled: boolean; out: ScreenStream; err?: ScreenStream; logBottom?: () => number | undefined }): void {
    if (!o.enabled || this.on) return;
    this.on = true;
    this.out = o.out;
    this.model = new CursorModel();
    this.entries = [];
    this.epoch = 0;
    this.logBottom = o.logBottom ?? (() => undefined);
    this.rawWrite = this.hook(o.out);
    if (o.err?.isTTY && o.err !== o.out) this.hook(o.err);
    o.out.on('resize', this.onResize);
  }

  stop(): void {
    if (!this.on) return;
    this.on = false;
    this.drop();
    for (const f of this.unhook.splice(0)) f();
    this.out?.off('resize', this.onResize);
    this.out = undefined;
    this.rawWrite = undefined;
    this.entries = [];
  }

  active(): boolean {
    return this.on;
  }

  /** Вызывать перед выводом строки размышления; undefined — экран выключен или курсор не в начале строки. */
  mark(): Mark | undefined {
    if (!this.on || this.model.col !== 0) return undefined;
    return { base: this.model.moved, epoch: this.model.epoch };
  }

  /** Вызывать сразу после вывода строки: сколько строк экрана она заняла, видно по движению курсора. */
  register(m: Mark, view: ThinkingView): void {
    if (!this.on || m.epoch !== this.model.epoch) return;
    this.sync();
    const rows = this.model.moved - m.base;
    if (rows < 1) return;
    this.entries.push({ view, base: m.base, headerRows: rows });
    this.prune();
  }

  /** Клик по строке экрана y (с 1): позиция курсора спрашивается у терминала, действие — по ответу. */
  click(y: number): void {
    if (!this.on || this.pending) return;
    this.sync();
    if (!this.entries.length || y > this.bottom()) return;
    const timer = setTimeout(() => (this.pending = undefined), REPLY_MS);
    timer.unref?.();
    this.pending = { y, ...this.position(), tries: 1, timer };
    this.raw(DSR);
  }

  /**
   * Ответ терминала на DSR. Он верен для того места вывода, где записан запрос: по нему ищется
   * строка под кликом. Если после запроса что-то вывелось, курсор уже в другой строке, и перед
   * действием позиция спрашивается снова.
   */
  cursor(row: number): void {
    const p = this.pending;
    if (!p) return;
    this.sync();
    if (p.epoch !== this.model.epoch) return this.drop();
    p.target ??= this.hit(p.y, row, p.moved);
    if (!p.target) return this.drop();
    const now = this.position();
    if (now.moved !== p.moved || now.col !== p.col) {
      if (p.tries >= QUERIES) return this.drop();
      p.tries++;
      Object.assign(p, now);
      this.raw(DSR);
      return;
    }
    this.drop();
    const { e, expand } = p.target;
    if (!this.entries.includes(e)) return;
    const top = row - (this.model.moved - e.base);
    if (expand) this.expand(e, top);
    else this.collapse(e, top);
  }

  private hook(stream: ScreenStream): Write {
    const own = Object.prototype.hasOwnProperty.call(stream, 'write');
    const orig = stream.write as Write;
    const decoder = new TextDecoder();
    const wrapped: Write = (chunk, ...rest) => {
      if (this.on) this.model.feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }), this.columns());
      return orig.call(stream, chunk, ...rest);
    };
    (stream as { write: Write }).write = wrapped;
    this.unhook.push(() => {
      if (own) (stream as { write: Write }).write = orig;
      else delete (stream as { write?: Write }).write;
    });
    return (chunk, ...rest) => orig.call(stream, chunk, ...rest);
  }

  private raw(s: string): void {
    this.rawWrite?.(s);
  }

  private columns(): number {
    return this.out?.columns ?? 80;
  }

  private rows(): number {
    return this.out?.rows ?? 24;
  }

  private bottom(): number {
    return this.logBottom() ?? this.rows();
  }

  /** Вернуть область прокрутки, какой она была: панель держит лог над собой. */
  private region(): string {
    const b = this.logBottom();
    return b ? `${ESC}[1;${b}r` : `${ESC}[r`;
  }

  private position(): Position {
    return { moved: this.model.moved, col: this.model.col, epoch: this.model.epoch };
  }

  private drop(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  /** Терминал переносит строки заново (resize): положение прежних строк больше не известно. */
  private forget(): void {
    this.drop();
    this.entries = [];
  }

  private sync(): void {
    if (this.epoch === this.model.epoch) return;
    this.epoch = this.model.epoch;
    this.entries = [];
  }

  /** Запись, у которой и нижняя строка дальше высоты экрана от курсора, уже не вернётся на экран. */
  private prune(): void {
    const rows = this.rows();
    this.entries = this.entries.filter((e) => this.model.moved - e.base - e.headerRows - (e.open ?? 0) < rows).slice(-MAX_ENTRIES);
  }

  /** Что под строкой y, если курсор стоял в строке cursorRow при moved: строка размышления или её текст. */
  private hit(y: number, cursorRow: number, moved: number): Target | undefined {
    if (y > this.bottom()) return undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      const top = cursorRow - (moved - e.base);
      const end = top + e.headerRows - 1;
      if (y >= top && y <= end) return { e, expand: !e.open };
      if (e.open && y > end && y <= end + e.open) return { e, expand: false };
    }
    return undefined;
  }

  /**
   * Текст встаёт под строкой, а строки над ней уходят вверх (в историю терминала): временная
   * область 1…y и переводы строк в её нижней строке. Строки ниже y и панель стоят на месте.
   */
  private expand(e: Entry, top: number): void {
    const y = top + e.headerRows - 1;
    const space = top - 1;
    if (space < 1) return;
    const columns = this.columns();
    const lines = e.view.body(columns);
    if (!lines.length) return;
    const shown = lines.length <= space ? lines : [...lines.slice(0, space - 1), e.view.more(lines.length - space + 1, columns)];
    const k = shown.length;
    let s = SAVE + `${ESC}[1;${y}r${ESC}[${y};1H` + '\n'.repeat(k);
    shown.forEach((l, i) => (s += `${ESC}[${y - k + 1 + i};1H${ESC}[2K${l}`));
    s += `${ESC}[${top - k};1H${e.view.header(true)}` + this.region() + RESTORE;
    this.raw(s);
    for (const x of this.entries) if (x.base <= e.base) x.base -= k;
    e.open = k;
  }

  /** Видимые строки текста удаляются, лог под ними поднимается, курсор лога — следом за ним. */
  private collapse(e: Entry, top: number): void {
    const first = top + e.headerRows;
    const from = Math.max(1, first);
    const n = first + (e.open ?? 0) - from;
    e.open = undefined;
    if (top < 1) this.entries = this.entries.filter((x) => x !== e);
    if (n <= 0) return;
    let s = SAVE + `${ESC}[${from};1H${ESC}[${n}M`;
    if (top >= 1) s += `${ESC}[${top};1H${e.view.header(false)}`;
    this.raw(s + RESTORE + `${ESC}[${n}A`);
    this.model.shift(-n);
    for (const x of this.entries) if (x.base > e.base) x.base -= n;
  }
}

export const screen = new Screen();
