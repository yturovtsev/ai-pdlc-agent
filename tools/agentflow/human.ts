// Диалоги с человеком: выбор стрелками из вариантов, рекомендуемый вариант подсвечен и
// обоснован. Без TTY и без --auto-approve решение человека невозможно → BLOCKED.
import { input, select } from '@inquirer/prompts';
import { c, log } from './log.ts';
import { Blocked } from './util.ts';

export interface Option<K extends string = string> {
  key: K;
  label: string;
  /** Что произойдёт при выборе; показывается под меню для подсвеченного варианта. */
  description?: string;
}

export interface Choice<K extends string = string> {
  title: string;
  /** Контекст решения: строки над меню (что случилось, что известно). */
  context?: string[];
  options: Option<K>[];
  recommended: K;
  /** Почему рекомендован именно этот вариант. */
  rationale: string;
}

export class Human {
  constructor(private readonly auto: boolean) {}

  private ensureTty(what: string): void {
    if (!process.stdin.isTTY) throw new Blocked(`нужно решение человека (${what}), а терминал не интерактивный: запусти в TTY или с --auto-approve`);
  }

  async select<K extends string>(ch: Choice<K>): Promise<K> {
    const rec = ch.options.find((o) => o.key === ch.recommended) ?? ch.options[0]!;
    console.log('');
    log.human(c.bold(ch.title));
    for (const line of ch.context ?? []) log.info(c.gray('  ' + line));
    log.info(c.green(`  ★ рекомендуется: ${rec.label}`) + c.gray(` — ${ch.rationale}`));
    if (this.auto) {
      log.info(c.gray(`  (--auto-approve) → ${rec.label}`));
      return rec.key;
    }
    this.ensureTty(ch.title);
    // Рекомендуемый вариант первым, под курсором и с пометкой; остальные в исходном порядке.
    const ordered = [rec, ...ch.options.filter((o) => o !== rec)];
    const answer = await select<K>({
      message: ch.title,
      default: rec.key,
      loop: false,
      pageSize: Math.max(ordered.length, 7),
      choices: ordered.map((o) => ({
        value: o.key,
        name: o === rec ? c.green(`★ ${o.label} (рекомендуется)`) : `  ${o.label}`,
        short: o.label,
        description: o === rec ? `${o.description ?? ''}${o.description ? '\n' : ''}Почему: ${ch.rationale}` : o.description,
      })),
    });
    log.info(c.gray(`  выбрано: ${ch.options.find((o) => o.key === answer)?.label}`));
    return answer;
  }

  async text(question: string, autoAnswer: string): Promise<string> {
    if (this.auto) {
      log.human(`${question}\n${c.gray('   (--auto-approve) →')} ${autoAnswer}`);
      return autoAnswer;
    }
    this.ensureTty(question);
    return (await input({ message: question })).trim() || autoAnswer;
  }

  /**
   * Вопрос с вариантами от модели: стрелками выбирается вариант, «Свой ответ» — ввод текста.
   * Варианты без рекомендации получают рекомендацию первого.
   */
  async question(q: { question: string; why?: string; options?: { label: string; description?: string }[]; recommended?: number; rationale?: string }): Promise<string> {
    const opts = (q.options ?? []).filter((o) => o.label);
    if (!opts.length) return this.text(q.question, 'на усмотрение автора: самый простой вариант, совместимый с intent');
    const recIdx = q.recommended !== undefined && q.recommended >= 0 && q.recommended < opts.length ? q.recommended : 0;
    const key = await this.select({
      title: q.question,
      context: q.why ? [`от ответа зависит: ${q.why}`] : [],
      options: [
        ...opts.map((o, i) => ({ key: String(i), label: o.label, description: o.description })),
        { key: 'own', label: 'Свой ответ…', description: 'ввести ответ текстом' },
      ],
      recommended: String(recIdx),
      rationale: q.rationale ?? 'вариант, который предложил автор как основной',
    });
    if (key === 'own') return this.text(q.question, opts[recIdx]!.label);
    return opts[Number(key)]!.label;
  }

  /** Ждать, пока человек сам отредактирует файлы. */
  async waitForEdit(paths: string[]): Promise<boolean> {
    if (this.auto) return true;
    const k = await this.select({
      title: 'Отредактируй файлы и выбери «Готово»',
      context: paths,
      options: [
        { key: 'done', label: 'Готово — перепроверить ревьюером' },
        { key: 'cancel', label: 'Отмена — вернуться к выбору' },
      ],
      recommended: 'done',
      rationale: 'после правки ревьюер проверит новую редакцию',
    });
    return k === 'done';
  }
}
