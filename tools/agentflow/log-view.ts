// В памяти — высоты, якорь и несколько страниц; исходный текст принадлежит журналу RunStore.
import { recordExpandable, renderRecord } from './log.ts';
import type { DisplayEntry, DisplayJournal, DisplayRecord } from './state.ts';
import { charWidth } from './terminal-text.ts';

/** Перенос с сохранением ANSI и OSC 8; управляющие команды не могут двигать курсор кадра. */
export function visualLines(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '', size = 0, style = '', link = '';
  const flush = () => {
    lines.push(line + (link ? '\x1b]8;;\x07' : '') + '\x1b[0m');
    line = style + link; size = 0;
  };
  for (const token of text.match(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]|[^]/gu) ?? []) {
    if (/^\x1b\[[0-9;]*m$/.test(token)) {
      style = token === '\x1b[0m' ? '' : style + token;
      line += token;
    } else if (token.startsWith('\x1b]8;;')) {
      link = token === '\x1b]8;;\x07' ? '' : token;
      line += token;
    } else if (token.startsWith('\x1b')) continue;
    else if (token === '\n') flush();
    else {
      const w = charWidth(token.codePointAt(0)!);
      if (!w && token !== '\u200d' && token.codePointAt(0)! < 32) continue;
      if (size + w > width && size) flush();
      if (w <= width) { line += token; size += w; }
    }
  }
  flush();
  return lines;
}

export class LogView {
  private cache = new Map<number, DisplayEntry[]>();
  private heights: number[] = [];
  private starts: number[] = [];
  private opened = new Set<number>();
  private anchor = { id: 0, offset: 0 };
  private total = 0;
  followTail = true;
  width = 80;
  height = 24;

  constructor(readonly journal: DisplayJournal, private readonly pageSize = 32, private readonly cachePages = 4) {
    for (let id = 0; id < journal.length; id++) this.measure(id);
  }

  private entry(id: number): DisplayEntry {
    const page = Math.floor(id / this.pageSize);
    let entries = this.cache.get(page);
    if (!entries) entries = this.journal.page(page * this.pageSize, this.pageSize);
    this.cache.delete(page); this.cache.set(page, entries);
    while (this.cache.size > this.cachePages) this.cache.delete(this.cache.keys().next().value!);
    return entries[id % this.pageSize]!;
  }

  private lines(id: number): string[] {
    return renderRecord(this.entry(id), this.opened.has(id), this.width, true).flatMap((s) => visualLines(s, this.width));
  }

  private measure(id: number): void {
    this.starts[id] = this.total;
    const height = this.lines(id).length;
    this.heights[id] = height; this.total += height;
  }

  append(record: DisplayRecord): void {
    const height = renderRecord(record, false, this.width, true).flatMap((s) => visualLines(s, this.width)).length;
    const entry = this.journal.append(record);
    this.cache.delete(Math.floor(entry.id / this.pageSize));
    this.starts[entry.id] = this.total;
    this.heights[entry.id] = height;
    this.total += height;
  }

  resize(width: number, height: number): void {
    this.height = height;
    if (width !== this.width) {
      this.width = width; this.total = 0;
      for (let id = 0; id < this.journal.length; id++) this.measure(id);
    }
    this.setTop(this.top, this.followTail);
  }

  get top(): number {
    if (this.followTail) return Math.max(0, this.total - this.height);
    return (this.starts[this.anchor.id] ?? 0) + Math.min(this.anchor.offset, (this.heights[this.anchor.id] ?? 1) - 1);
  }

  private locate(row: number): number {
    let lo = 0, hi = this.starts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid]! <= row) lo = mid; else hi = mid;
    }
    return lo;
  }

  private setTop(row: number, follow: boolean): void {
    const top = Math.max(0, Math.min(row, Math.max(0, this.total - this.height)));
    const id = this.locate(top);
    this.anchor = { id, offset: top - (this.starts[id] ?? 0) };
    this.followTail = follow;
  }

  scroll(delta: number): void {
    const next = this.top + delta;
    this.setTop(next, Math.max(0, next) >= Math.max(0, this.total - this.height));
  }
  end(): void { this.followTail = true; }

  toggle(id: number): void {
    if (!recordExpandable(this.entry(id), this.width)) return;
    const top = this.top;
    if (this.opened.has(id)) this.opened.delete(id); else this.opened.add(id);
    this.total = this.starts[id]!;
    for (let i = id; i < this.journal.length; i++) this.measure(i);
    this.setTop(Math.min(top, this.starts[id]!), false);
  }

  frame(): { text: string; block?: number }[] {
    const frame: { text: string; block?: number }[] = [];
    const top = this.top;
    for (let id = this.locate(top); id < this.journal.length && frame.length < this.height; id++) {
      const block = recordExpandable(this.entry(id), this.width) ? id : undefined;
      const lines = this.lines(id);
      const first = Math.max(0, top - this.starts[id]!);
      for (const text of lines.slice(first, first + this.height - frame.length)) frame.push({ text, block });
    }
    return frame;
  }
}
