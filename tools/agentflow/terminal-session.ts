// Единственный владелец окна, ввода и cleanup; экспорт нужен также проверкам без запуска controller.main.
import { configureThinking, log, renderRecord, setDisplaySink, setStreamWriter } from './log.ts';
import { join } from 'node:path';
import { LogView } from './log-view.ts';
import { Mouse, mouseEnabled, type MouseInput } from './mouse.ts';
import { Screen } from './screen.ts';
import { RunStore, type DisplayJournal } from './state.ts';
import { panel, panelEnabled, type PanelOut } from './status-panel.ts';

export interface TerminalOptions {
  store: RunStore;
  out: PanelOut;
  input: MouseInput;
  noMouse?: boolean;
  noPanel?: boolean;
  env?: Record<string, string | undefined>;
  panel: { runId: string; change: string; roles: number; launches: number; phase?: string; stallMs?: number };
}

let current: TerminalSession | undefined;
export function terminalDialog(): { resume(): void } | undefined {
  if (!current?.active) return undefined;
  const session = current;
  session.pause();
  return { resume: () => session.resume() };
}

export class TerminalSession {
  private journal: DisplayJournal | undefined;
  private screen: Screen | undefined;
  private mouse = new Mouse();
  private closed = false;
  private restored = false;
  private paused = false;
  active = false;
  private readonly onResize = () => this.draw();
  private readonly onExit = () => this.restore();
  private readonly onInt = () => { this.close(); process.exit(130); };
  private readonly onTerm = () => { this.close(); process.exit(143); };

  constructor(private readonly options: TerminalOptions) {}

  start(): this {
    const { out, input, store, env = process.env } = this.options;
    setStreamWriter((text) => out.write(text));
    configureThinking({ dir: join(store.runDir, 'thinking'), links: !!out.isTTY });
    if (!mouseEnabled({ stdinTTY: input.isTTY, stdoutTTY: out.isTTY, noMouse: this.options.noMouse, env })) {
      panel.start({ ...this.options.panel, enabled: panelEnabled({ isTTY: out.isTTY, rows: out.rows, cols: out.columns, noPanel: this.options.noPanel, env }) }, out);
      return this;
    }
    try { this.journal = store.createDisplayJournal(); }
    catch (error) {
      log.error(`журнал отображения недоступен, продолжаю потоковый вывод: ${String(error)}`);
      return this;
    }
    const view = new LogView(this.journal);
    this.screen = new Screen(view, out, () => panel.frame());
    this.active = true;
    current = this;
    out.write('\x1b[?1049h\x1b[2J\x1b[H');
    out.on('resize', this.onResize);
    process.on('exit', this.onExit);
    process.once('SIGINT', this.onInt);
    process.once('SIGTERM', this.onTerm);
    panel.start({ ...this.options.panel, enabled: !this.options.noPanel && env['AGENTFLOW_NO_PANEL'] !== '1', managed: () => this.draw() }, out);
    this.mouse.start({ enabled: true, managed: true, input, out, handlers: {
      click: (_x, y) => this.screen?.click(y),
      wheel: (up) => this.screen?.scroll(up ? -1 : 1),
      key: (key) => key === 'end' ? this.screen?.end() : this.screen?.page(key === 'pageUp'),
    } });
    setDisplaySink({
      retainWhileHeld: true,
      append: (record) => { view.append(record); this.draw(); },
      fail: () => { this.fallback(); setStreamWriter((text) => out.write(text)); },
    });
    this.draw();
    return this;
  }

  private draw(): void {
    if (!this.active || this.paused) return;
    try { this.screen?.draw(); }
    catch (error) {
      this.close();
      setStreamWriter((text) => this.options.out.write(text));
      log.error(`окно лога недоступно, продолжаю потоковый вывод: ${String(error)}`);
    }
  }

  pause(): void {
    if (!this.active || this.paused) return;
    log.hold();
    this.paused = true;
    this.mouse.pause();
    this.screen?.pause();
    panel.pause();
    this.options.out.write('\x1b[2J\x1b[H\x1b[?25h');
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.closed) { log.release(); return; }
    panel.resume();
    this.screen?.resume();
    this.mouse.resume();
    log.release();
  }

  private restore(): void {
    if (this.restored) return;
    this.restored = true;
    this.mouse.stop();
    panel.stop();
    if (this.active) this.options.out.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
    this.active = false;
  }

  private fallback(): void {
    this.close();
  }

  close(): void {
    if (this.closed) { setStreamWriter(); return; }
    this.closed = true;
    setDisplaySink();
    this.restore();
    if (this.paused) { this.paused = false; log.release(); }
    this.options.out.off('resize', this.onResize);
    process.off('exit', this.onExit);
    process.off('SIGINT', this.onInt);
    process.off('SIGTERM', this.onTerm);
    if (current === this) current = undefined;
    const journal = this.journal;
    if (journal) {
      try {
        for (let i = 0; i < journal.length; i += 32) {
          for (const entry of journal.page(i, 32)) this.options.out.write(renderRecord(entry, false, this.options.out.columns || 120, false).join('\n') + '\n');
        }
      } finally { journal.close(); }
    }
    setStreamWriter();
  }
}

export function startTerminalSession(options: TerminalOptions): TerminalSession {
  return new TerminalSession(options).start();
}
