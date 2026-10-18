// Два человеческих шлюза: согласование спеки и приёмка. Плюс ответы на уточнения.
import { createInterface } from 'node:readline/promises';
import { c, log } from './log.ts';
import { Blocked } from './util.ts';

export class Human {
  constructor(private readonly auto: boolean) {}

  async ask(question: string, autoAnswer: string): Promise<string> {
    if (this.auto) {
      log.human(`${question}\n${c.gray('   (--auto-approve) →')} ${autoAnswer}`);
      return autoAnswer;
    }
    if (!process.stdin.isTTY) throw new Blocked('нужно решение человека, а терминал не интерактивный: запусти в TTY или с --auto-approve');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(c.bold(c.yellow('☺ ' + question + '\n  > ')))).trim();
      return answer;
    } finally {
      rl.close();
    }
  }

  async choose(question: string, options: { key: string; label: string }[], autoKey: string): Promise<string> {
    const menu = options.map((o) => `[${o.key}] ${o.label}`).join('  ');
    for (;;) {
      const a = (await this.ask(`${question}  ${menu}`, autoKey)).toLowerCase();
      if (options.some((o) => o.key === a)) return a;
      log.warn(`введи одну из клавиш: ${options.map((o) => o.key).join(', ')}`);
    }
  }
}
