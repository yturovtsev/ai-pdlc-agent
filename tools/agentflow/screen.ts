// Кадр строится только из истории: перерисовка не является новым выводом лога.
import type { LogView } from './log-view.ts';
import { visualLines } from './log-view.ts';
import type { PanelOut } from './status-panel.ts';
export { charWidth, textWidth, wrapText } from './terminal-text.ts';

export class Screen {
  private hits = new Map<number, number>();
  private paused = false;
  constructor(private readonly view: LogView, private readonly out: PanelOut, private readonly panelLines: () => string[]) {}

  draw(): void {
    if (this.paused) return;
    const rows = Math.max(1, this.out.rows ?? 24);
    const columns = Math.max(1, this.out.columns ?? 80);
    const panel = this.panelLines();
    const height = Math.max(1, rows - panel.length);
    this.view.resize(columns, height);
    const frame = this.view.frame();
    const hits = new Map<number, number>();
    let data = '\x1b[?25l';
    for (let i = 0; i < rows; i++) {
      const line = i < height ? frame[i]?.text ?? '' : visualLines(panel[i - height] ?? '', columns)[0] ?? '';
      data += `\x1b[${i + 1};1H\x1b[2K${line}`;
      const id = frame[i]?.block;
      if (i < height && id !== undefined) hits.set(i + 1, id);
    }
    this.out.write(data);
    this.hits = hits;
  }

  click(row: number): void {
    const id = this.hits.get(row);
    if (this.paused || id === undefined) return;
    this.view.toggle(id);
    this.draw();
  }

  scroll(delta: number): void { this.view.scroll(delta); this.draw(); }
  end(): void { this.view.end(); this.draw(); }
  page(up: boolean): void { this.scroll((up ? -1 : 1) * this.view.height); }
  pause(): void { this.paused = true; this.hits.clear(); }
  resume(): void { this.paused = false; this.draw(); }
}
