// Панель статуса внизу терминала: текущий субагент, его модель, effort и время, этап и петля.
// Закрепляется областью прокрутки (DECSTBM): лог, включая console.log мимо log.ts, прокручивается
// над двумя нижними строками. Состояние пополняют хуки log.ts; без start() всё — no-op.
import { c, paintRole } from './log.ts';

export interface PanelAgent {
  role: string;
  /** Над чем работает: артефакт и файл, батч, вид ревью. */
  target?: string;
  model: string;
  effort?: string;
  resume: boolean;
  startedAt: number;
  tools: number;
}

export interface PanelState {
  runId: string;
  change: string;
  /** Ролей в конвейере. */
  roles: number;
  /** Запусков субагентов в run, включая прошлые команды до resume. */
  launches: number;
  phase: string;
  loop?: { name: string; round: number; max: number };
  agent?: PanelAgent;
  /** Что делает контроллер, когда субагента нет. */
  activity: string;
  /** Начало текущей команды run/resume. */
  startedAt: number;
}

export interface PanelOut {
  isTTY?: boolean;
  rows?: number;
  columns?: number;
  write(s: string): unknown;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

const HEIGHT = 2;
export const MIN_ROWS = 10;
export const MIN_COLS = 40;
const ESC = '\x1b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const ANSI = /\x1b\[[0-9;]*m/y;

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

export function panelEnabled(o: { isTTY?: boolean; rows?: number; cols?: number; noPanel?: boolean; env?: Record<string, string | undefined> }): boolean {
  if (!o.isTTY || o.noPanel || o.env?.['AGENTFLOW_NO_PANEL'] === '1') return false;
  return (o.rows ?? 0) >= MIN_ROWS && (o.cols ?? 0) >= MIN_COLS;
}

/** Обрезка по видимой ширине: ANSI-последовательности не считаются и не разрываются. */
export function fit(s: string, width: number): string {
  if ([...stripAnsi(s)].length <= width) return s;
  let out = '';
  let visible = 0;
  let colored = false;
  for (let i = 0; i < s.length; ) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m) {
      out += m[0];
      colored = true;
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (visible === width - 1) break;
    out += ch;
    visible++;
    i += ch.length;
  }
  return out + '…' + (colored ? `${ESC}[0m` : '');
}

function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Две строки панели: субагент (или контроллер) и контекст прогона. Время и цель — первыми, чтобы не обрезались. */
export function renderPanel(s: PanelState, width: number, now: number): [string, string] {
  const sep = c.gray(' · ');
  const counts = `запуск ${s.launches}${sep}ролей ${s.roles}`;
  const a = s.agent;
  const top = a
    ? [
        paintRole(a.role, `▶ ${a.role}`) + ' ' + c.bold(clock(now - a.startedAt)),
        ...(a.target ? [c.bold(a.target)] : []),
        a.model,
        `effort ${a.effort ?? 'по умолчанию'}`,
        a.resume ? 'продолжение сессии' : 'новая сессия',
        `инстр. ${a.tools}`,
        counts,
      ].join(sep)
    : [c.gray('⚙ контроллер'), s.activity || 'работает', counts].join(sep);
  const bottom = c.gray(
    [
      `⏱ ${clock(now - s.startedAt)}`,
      ...(s.loop ? [`петля «${s.loop.name}» ${s.loop.round}/${s.loop.max}`] : []),
      ...(s.phase ? [s.phase] : []),
      `change ${s.change}`,
      `run ${s.runId}`,
    ].join(' · '),
  );
  return [fit(top, width), fit(bottom, width)];
}

class Panel {
  private state: PanelState | undefined;
  private out: PanelOut | undefined;
  private active = false;
  private paused = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly onResize = () => this.resize();
  private readonly onExit = () => this.stop();
  private readonly onSigint = () => this.exitBySignal(130);
  private readonly onSigterm = () => this.exitBySignal(143);

  start(init: { runId: string; change: string; roles: number; launches: number; phase?: string; enabled: boolean }, out: PanelOut = process.stdout): void {
    if (!init.enabled || this.active) return;
    this.out = out;
    this.state = { runId: init.runId, change: init.change, roles: init.roles, launches: init.launches, phase: init.phase ?? '', activity: 'старт', startedAt: Date.now() };
    this.active = true;
    this.paused = false;
    out.on('resize', this.onResize);
    process.on('exit', this.onExit);
    process.once('SIGINT', this.onSigint);
    process.once('SIGTERM', this.onSigterm);
    this.reserve();
    this.tick();
  }

  update(patch: Partial<PanelState> | ((s: PanelState) => void)): void {
    if (!this.state) return;
    if (typeof patch === 'function') patch(this.state);
    else Object.assign(this.state, patch);
    this.draw();
  }

  /** На время диалога: область прокрутки снята, нижние строки свободны для меню. */
  pause(): void {
    if (!this.active || this.paused) return;
    this.paused = true;
    this.halt();
    this.release();
  }

  resume(): void {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this.reserve();
    this.tick();
  }

  /** Идемпотентно: снять область, стереть панель, вернуть курсор; слушатели снимаются. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.halt();
    if (!this.paused) this.release();
    this.paused = false;
    this.out?.write(`${ESC}[?25h`);
    this.out?.off('resize', this.onResize);
    process.off('exit', this.onExit);
    process.off('SIGINT', this.onSigint);
    process.off('SIGTERM', this.onSigterm);
    this.state = undefined;
  }

  private exitBySignal(code: number): void {
    this.stop();
    process.exit(code);
  }

  private rows(): number {
    return this.out?.rows ?? 0;
  }

  private tick(): void {
    this.halt();
    this.draw();
    this.timer = setInterval(() => this.draw(), 1000);
    this.timer.unref();
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Освободить две нижние строки под курсором и закрепить область над ними. Курсор стоит в
   * начале пустой строки после лога; ESC[J стирает остатки прежней панели ниже него.
   * DECSTBM переводит курсор в начало экрана — отсюда SAVE/RESTORE вокруг.
   */
  private reserve(): void {
    const rows = this.rows();
    this.out?.write('\n'.repeat(HEIGHT) + `${ESC}[${HEIGHT}A${ESC}[J` + SAVE + `${ESC}[1;${rows - HEIGHT}r` + RESTORE);
  }

  private release(): void {
    const rows = this.rows();
    let s = SAVE + `${ESC}[r`;
    for (let i = HEIGHT - 1; i >= 0; i--) s += `${ESC}[${rows - i};1H${ESC}[2K`;
    this.out?.write(s + RESTORE);
  }

  private draw(): void {
    if (!this.active || this.paused || !this.state || !this.out) return;
    const rows = this.rows();
    const lines = renderPanel(this.state, this.out.columns ?? 80, Date.now());
    let s = SAVE;
    lines.forEach((l, i) => (s += `${ESC}[${rows - HEIGHT + 1 + i};1H${ESC}[2K${l}`));
    this.out.write(s + RESTORE);
  }

  private resize(): void {
    if (!this.active || !this.out) return;
    // Терминал стал меньше порога: панель выключается до конца run.
    if (!panelEnabled({ isTTY: true, rows: this.out.rows, cols: this.out.columns })) return this.stop();
    if (this.paused) return;
    this.out.write(SAVE + `${ESC}[r` + RESTORE);
    this.reserve();
    this.draw();
  }
}

export const panel = new Panel();
