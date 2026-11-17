// Режим мыши на время run: терминал сообщает о кликах (режимы 1000 и 1006), клик передаётся экрану
// лога, а тот раскрывает или сворачивает размышление. Ввод в raw-режиме: Ctrl+C приходит байтом,
// и сигнал отправляется всей группе процессов, как это делает терминал. Без start() всё — no-op.

const ESC = '\x1b';
const REPORT_ON = `${ESC}[?1000h${ESC}[?1006h`;
const REPORT_OFF = `${ESC}[?1000l${ESC}[?1006l`;
export function mouseEnabled(o: { stdinTTY?: boolean; stdoutTTY?: boolean; noMouse?: boolean; env?: Record<string, string | undefined> }): boolean {
  return !!o.stdinTTY && !!o.stdoutTTY && !o.noMouse && o.env?.['AGENTFLOW_NO_MOUSE'] !== '1';
}

export type InputEvent =
  | { kind: 'press' | 'release'; button: number; x: number; y: number }
  | { kind: 'wheel'; up: boolean }
  | { kind: 'motion' }
  | { kind: 'cursor'; row: number; col: number }
  | { kind: 'interrupt' }
  | { kind: 'key'; key: 'pageUp' | 'pageDown' | 'end' };

const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const CURSOR = /^\x1b\[(\d+);(\d+)R/;
// Начало одной из этих последовательностей: ждать продолжения в следующем data.
const PARTIAL = /^\x1b(\[(<[\d;]*|[\d;]*)?|O)?$/;

/** Разбор ввода терминала: SGR-отчёт мыши, ответ о позиции курсора, Ctrl+C; остальное пропускается. */
export class InputParser {
  private buf = '';

  feed(data: string): InputEvent[] {
    const events: InputEvent[] = [];
    let s = this.buf + data;
    this.buf = '';
    while (s) {
      if (s[0] === '\x03') {
        events.push({ kind: 'interrupt' });
        s = s.slice(1);
        continue;
      }
      if (s[0] !== ESC) {
        const next = s.search(/[\x1b\x03]/);
        s = next < 0 ? '' : s.slice(next);
        continue;
      }
      const m = MOUSE.exec(s);
      if (m) {
        events.push(mouseEvent(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === 'M'));
        s = s.slice(m[0].length);
        continue;
      }
      const key = /^\x1b\[(5~|6~|4~|1;\d+F|F)/.exec(s) ?? /^\x1bO(F)/.exec(s);
      if (key) {
        events.push({ kind: 'key', key: key[1] === '5~' ? 'pageUp' : key[1] === '6~' ? 'pageDown' : 'end' });
        s = s.slice(key[0].length); continue;
      }
      const r = CURSOR.exec(s);
      if (r) {
        events.push({ kind: 'cursor', row: Number(r[1]), col: Number(r[2]) });
        s = s.slice(r[0].length);
        continue;
      }
      if (PARTIAL.test(s) && s.length < 32) {
        this.buf = s;
        break;
      }
      s = s.slice(1);
    }
    return events;
  }
}

function mouseEvent(b: number, x: number, y: number, press: boolean): InputEvent {
  if (b & 64) return { kind: 'wheel', up: (b & 1) === 0 };
  if (b & 32) return { kind: 'motion' };
  return { kind: press ? 'press' : 'release', button: b & 3, x, y };
}

export interface MouseInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (d: Buffer | string) => void): unknown;
  off(event: 'data', listener: (d: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  ref?(): unknown;
  unref?(): unknown;
}

export interface MouseHandlers {
  /** Нажатие левой кнопки: колонка и строка экрана с 1. */
  click(x: number, y: number): void;
  /** Ответ терминала на запрос позиции курсора. */
  cursor?(row: number, col: number): void;
  wheel(up: boolean): void;
  key(key: 'pageUp' | 'pageDown' | 'end'): void;
}

export class Mouse {
  private input: MouseInput | undefined;
  private out: { write(s: string): unknown } | undefined;
  private handlers: MouseHandlers | undefined;
  private active = false;
  private paused = false;
  private managed = false;
  private parser = new InputParser();
  private readonly onData = (d: Buffer | string) => this.data(String(d));
  private readonly onExit = () => this.stop();
  private readonly onSigint = () => this.exitBySignal(130);
  private readonly onSigterm = () => this.exitBySignal(143);

  start(o: { enabled: boolean; managed?: boolean; input: MouseInput; out: { write(s: string): unknown }; handlers: MouseHandlers }): void {
    if (!o.enabled || this.active) return;
    this.managed = !!o.managed;
    this.input = o.input;
    this.out = o.out;
    this.handlers = o.handlers;
    this.active = true;
    this.paused = false;
    if (!this.managed) {
      process.on('exit', this.onExit);
      process.once('SIGINT', this.onSigint);
      process.once('SIGTERM', this.onSigterm);
    }
    this.attach();
  }

  /** На время диалога: отчёт выключен, ввод отдан меню в обычном режиме. */
  pause(): void {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.detach();
  }

  resume(): void {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this.attach();
  }

  /** Идемпотентно: отчёт выключен, raw-режим снят, stdin больше не держит процесс. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (!this.paused) this.detach();
    this.paused = false;
    this.input?.unref?.();
    process.off('exit', this.onExit);
    process.off('SIGINT', this.onSigint);
    process.off('SIGTERM', this.onSigterm);
    this.input = undefined;
    this.out = undefined;
    this.handlers = undefined;
  }

  private exitBySignal(code: number): void {
    this.stop();
    process.exit(code);
  }

  private attach(): void {
    const input = this.input!;
    input.setRawMode?.(true);
    input.on('data', this.onData);
    input.ref?.();
    input.resume();
    this.out?.write(REPORT_ON);

  }

  private detach(): void {

    this.out?.write(REPORT_OFF);

    const input = this.input!;
    input.off('data', this.onData);
    input.setRawMode?.(false);
    input.pause();
    this.parser = new InputParser();
  }

  private data(d: string): void {
    for (const ev of this.parser.feed(d)) {
      if (ev.kind === 'interrupt') interrupt();
      else if (ev.kind === 'wheel') this.handlers?.wheel(ev.up);
      else if (ev.kind === 'key') this.handlers?.key(ev.key);
      else if (ev.kind === 'cursor') this.handlers?.cursor?.(ev.row, ev.col);
      else if (ev.kind === 'press' && ev.button === 0) this.handlers?.click(ev.x, ev.y);
    }
  }

}

/** Ctrl+C в raw-режиме: SIGINT всей группе процессов, как от терминала (обёртка, CLI ролей, гейты). */
function interrupt(): void {
  try {
    process.kill(0, 'SIGINT');
  } catch {
    process.kill(process.pid, 'SIGINT');
  }
}

export const mouse = new Mouse();
