import { EventEmitter } from 'node:events';
import { charWidth } from '../terminal-text.ts';

export class FakeInput extends EventEmitter {
  isTTY = true;
  raw = false;
  setRawMode(raw: boolean): void { this.raw = raw; }
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

export class Vt {
  grid: string[][];
  history: string[] = [];
  replies: [number, number][] = [];
  r = 0;
  c = 0;
  wraps = 0;
  private top = 0;
  private bottom: number;
  private saved = { r: 0, c: 0 };
  private mode: 'text' | 'esc' | 'csi' | 'osc' = 'text';
  private params = '';
  reporting = false;
  wheelAllowed = true;
  scrollbackWithStatus = false;
  alternate = false;
  viewport = 0;
  private main: { grid: string[][]; r: number; c: number; top: number; bottom: number } | undefined;
  resize(rows: number, cols: number): void {
    this.rows = rows; this.cols = cols;
    this.grid = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => this.grid[i]?.[j] ?? ' '));
    this.r = Math.min(this.r, rows - 1); this.c = Math.min(this.c, cols - 1);
    this.top = 0; this.bottom = rows - 1;
  }
  wheel(up: boolean, input: FakeInput): void {
    if (this.reporting && this.wheelAllowed && this.viewport === 0) input.emit('data', `\x1b[<${up ? 64 : 65};2;2M`);
    else this.viewport = Math.max(0, Math.min(this.history.length, this.viewport + (up ? 1 : -1)));
  }
  click(row: number, input: FakeInput): void {
    if (this.reporting && this.viewport === 0) input.emit('data', `\x1b[<0;2;${row}M`);
  }

  constructor(
    public rows: number,
    public cols: number,
  ) {
    this.grid = Array.from({ length: rows }, () => this.blank());
    this.bottom = rows - 1;
  }
  private blank(): string[] {
    return Array<string>(this.cols).fill(' ');
  }
  lines(): string[] {
    return this.grid.map((l) => l.join('').trimEnd());
  }
  /** Строка экрана (с 1), где есть text, или 0. */
  row(text: string): number {
    return this.lines().findIndex((l) => l.includes(text)) + 1;
  }
  feed(s: string): void {
    for (const ch of s) {
      if (this.mode === 'esc') this.escape(ch);
      else if (this.mode === 'csi') this.csi(ch);
      else if (this.mode === 'osc') this.mode = ch === '\x07' ? 'text' : 'osc';
      else this.text(ch);
    }
  }
  private text(ch: string): void {
    const cp = ch.codePointAt(0)!;
    if (ch === '\x1b') this.mode = 'esc';
    else if (ch === '\n') {
      this.c = 0;
      this.lf();
    } else if (ch === '\r') this.c = 0;
    else if (cp >= 0x20) {
      const w = charWidth(cp);
      if (!w) return;
      if (this.c + w > this.cols) {
        this.c = 0;
        this.lf();
        this.wraps++;
      }
      this.grid[this.r]![this.c] = ch;
      if (w === 2) this.grid[this.r]![this.c + 1] = '';
      this.c += w;
    }
  }
  private escape(ch: string): void {
    this.mode = ch === '[' ? 'csi' : ch === ']' ? 'osc' : 'text';
    this.params = '';
    if (ch === '7') this.saved = { r: this.r, c: this.c };
    if (ch === '8') ({ r: this.r, c: this.c } = this.saved);
  }
  private csi(ch: string): void {
    if (/[0-9;?]/.test(ch)) {
      this.params += ch;
      return;
    }
    this.mode = 'text';
    if (this.params.startsWith('?')) {
      const on = ch === 'h';
      if (this.params === '?1000') this.reporting = on;
      if (this.params === '?1049') {
        if (on && !this.alternate) {
          this.main = { grid: this.grid, r: this.r, c: this.c, top: this.top, bottom: this.bottom };
          this.grid = Array.from({ length: this.rows }, () => this.blank());
          this.r = this.c = this.top = 0; this.bottom = this.rows - 1;
        } else if (!on && this.main) { Object.assign(this, this.main); this.main = undefined; }
        this.alternate = on;
      }
      return;
    }
    const [a, b] = this.params.split(';').map((x) => (x === '' ? undefined : Number(x)));
    const n = Math.max(1, a ?? 1);
    const clear = (r: number, from: number) => {
      for (let i = Math.min(from, this.cols - 1); i < this.cols; i++) this.grid[r]![i] = ' ';
    };
    switch (ch) {
      case 'H':
        this.r = Math.max(0, Math.min(this.rows - 1, (a ?? 1) - 1));
        this.c = Math.max(0, (b ?? 1) - 1);
        break;
      case 'A':
        this.r = Math.max(this.r >= this.top ? this.top : 0, this.r - n);
        break;
      case 'B':
        this.r = Math.min(this.r <= this.bottom ? this.bottom : this.rows - 1, this.r + n);
        break;
      case 'G':
        this.c = n - 1;
        break;
      case 'K':
        clear(this.r, a === 2 ? 0 : this.c);
        break;
      case 'J':
        if (a === 2) this.grid = this.grid.map(() => this.blank());
        else {
          clear(this.r, this.c);
          for (let r = this.r + 1; r < this.rows; r++) this.grid[r] = this.blank();
        }
        break;
      case 'M':
        if (this.r >= this.top && this.r <= this.bottom) {
          for (let i = 0; i < n; i++) {
            this.grid.splice(this.r, 1);
            this.grid.splice(this.bottom, 0, this.blank());
          }
        }
        this.c = 0;
        break;
      case 'r':
        this.top = (a ?? 1) - 1;
        this.bottom = (b ?? this.rows) - 1;
        this.r = 0;
        this.c = 0;
        break;
      case 'n':
        if (a === 6) this.replies.push([this.r + 1, Math.min(this.c, this.cols - 1) + 1]);
        break;
    }
  }
  private lf(): void {
    if (this.r === this.bottom) {
      const [gone] = this.grid.splice(this.top, 1);
      if (this.top === 0 && !this.alternate && (this.bottom === this.rows - 1 || this.scrollbackWithStatus)) this.history.push(gone!.join('').trimEnd());
      this.grid.splice(this.bottom, 0, this.blank());
    } else if (this.r < this.rows - 1) this.r++;
  }
}


export class FakeTerminal extends EventEmitter {
  isTTY = true;
  writes: string[] = [];
  vt: Vt;
  constructor(public rows = 30, public columns = 120) { super(); this.vt = new Vt(rows, columns); }
  write(s: string): boolean { this.writes.push(s); this.vt.feed(s); return true; }
  resize(rows: number, columns: number): void { this.rows = rows; this.columns = columns; this.vt.resize(rows, columns); this.emit('resize'); }
}
