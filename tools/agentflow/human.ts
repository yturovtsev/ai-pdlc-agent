// Диалоги с человеком: выбор стрелками из вариантов, рекомендуемый вариант подсвечен и
// обоснован. Без TTY и без --auto-approve решение человека невозможно → BLOCKED.
import { input, select } from '@inquirer/prompts';
import type { DiscussReply } from './context-builder.ts';
import { c, log } from './log.ts';
import type { DiscussTurn, QuestionOption } from './state.ts';
import { panel } from './status-panel.ts';
import { Blocked, now } from './util.ts';

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

/**
 * Меню inquirer рисуется без панели: она убрана на время диалога и возвращается после ответа.
 * Лог удержан: работающая сессия (диалог вмешательства) не рвёт меню, её строки выйдут после.
 */
async function paused<T>(fn: () => Promise<T>): Promise<T> {
  panel.pause();
  log.hold();
  try {
    return await fn();
  } finally {
    log.release();
    panel.resume();
  }
}

/** Ввод человека: по умолчанию @inquirer/prompts и TTY процесса, в unit-тестах — сценарий ответов. */
export interface PromptIO {
  select(
    config: { message: string; default?: string; loop?: boolean; pageSize?: number; choices: { value: string; name: string; short?: string; description?: string }[] },
    context?: { signal?: AbortSignal },
  ): Promise<string>;
  input(config: { message: string }): Promise<string>;
  tty(): boolean;
}

const INQUIRER: PromptIO = {
  select: (config, context) => select(config, context),
  input: (config) => input(config),
  tty: () => !!process.stdin.isTTY,
};

/** Вопрос в том виде, в каком его видит человек сейчас: варианты могли уточниться в обсуждении. */
export interface QuestionView {
  question: string;
  why?: string;
  options: QuestionOption[];
  recommended: number;
  rationale?: string;
}

/** Обсуждение вопроса с ролью, которая его задала. Реплику выполняет контроллер. */
export interface Discuss {
  /** Кто отвечает — для заголовка ответа. */
  role: string;
  /** Уже сохранённая переписка (resume). */
  history: DiscussTurn[];
  /** limits.discussTurns: через столько реплик — диалог «продолжить или выбрать»; 0 — без диалога. */
  limit: number;
  reply(message: string, history: DiscussTurn[], q: QuestionView): Promise<DiscussReply | { error: string }>;
  /** Реплика удалась: сохранить вопрос (с уточнёнными вариантами) и переписку. */
  onTurn(turn: DiscussTurn, q: QuestionView): void;
  /** Fault injection discuss-question: реплика без человека до первого меню. */
  autoMessage?: string;
}

export class Human {
  constructor(
    private readonly auto: boolean,
    private readonly io: PromptIO = INQUIRER,
  ) {}

  private ensureTty(what: string): void {
    if (!this.io.tty()) throw new Blocked(`нужно решение человека (${what}), а терминал не интерактивный: запусти в TTY или с --auto-approve`);
  }

  async select<K extends string>(ch: Choice<K>): Promise<K> {
    return (await this.choose(ch))!;
  }

  /** Диалог, который можно закрыть извне: при отмене через signal возвращает undefined. */
  async selectOrCancel<K extends string>(ch: Choice<K>, signal: AbortSignal): Promise<K | undefined> {
    return this.choose(ch, signal);
  }

  private async choose<K extends string>(ch: Choice<K>, signal?: AbortSignal): Promise<K | undefined> {
    const rec = ch.options.find((o) => o.key === ch.recommended) ?? ch.options[0]!;
    console.log('');
    log.human(c.bold(ch.title));
    for (const line of ch.context ?? []) log.info(c.gray('  ' + line));
    log.info(c.green(`  ★ рекомендуется: ${rec.label}`) + c.gray(` — ${ch.rationale}`));
    if (this.auto) {
      log.info(c.gray(`  (--auto-approve) → ${rec.label}`));
      return rec.key;
    }
    if (signal?.aborted) return undefined;
    this.ensureTty(ch.title);
    // Рекомендуемый вариант первым, под курсором и с пометкой; остальные в исходном порядке.
    const ordered = [rec, ...ch.options.filter((o) => o !== rec)];
    const answer = await paused(async () => {
      try {
        return (await this.io.select(
          {
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
          },
          { signal },
        )) as K;
      } catch (e) {
        if (signal?.aborted && e instanceof Error && e.name === 'AbortPromptError') return undefined;
        throw e;
      }
    });
    if (answer === undefined) {
      log.info(c.gray('  диалог закрыт без выбора'));
      return undefined;
    }
    log.info(c.gray(`  выбрано: ${ch.options.find((o) => o.key === answer)?.label}`));
    return answer;
  }

  async text(question: string, autoAnswer: string): Promise<string> {
    if (this.auto) {
      log.human(`${question}\n${c.gray('   (--auto-approve) →')} ${autoAnswer}`);
      return autoAnswer;
    }
    this.ensureTty(question);
    return (await paused(() => this.io.input({ message: question }))).trim() || autoAnswer;
  }

  /**
   * Вопрос с вариантами от модели: стрелками выбирается вариант, «Свой ответ» — ввод текста,
   * «Обсудить» (если передан discuss) — реплика роли, задавшей вопрос, и снова меню.
   * Варианты без рекомендации получают рекомендацию первого.
   */
  async question(
    q: { question: string; why?: string; options?: QuestionOption[]; recommended?: number; rationale?: string },
    discuss?: Discuss,
  ): Promise<{ answer: string; discussion: DiscussTurn[] }> {
    const history = [...(discuss?.history ?? [])];
    const opts = (q.options ?? []).filter((o) => o.label);
    if (!opts.length) return { answer: await this.text(q.question, 'на усмотрение автора: самый простой вариант, совместимый с intent'), discussion: history };
    const view: QuestionView = {
      question: q.question,
      why: q.why,
      options: opts,
      recommended: q.recommended !== undefined && q.recommended >= 0 && q.recommended < opts.length ? q.recommended : 0,
      rationale: q.rationale,
    };
    if (discuss?.autoMessage) {
      log.info(c.gray(`  реплика обсуждения (fault injection): ${discuss.autoMessage}`));
      await this.discussTurn(discuss, discuss.autoMessage, history, view);
    }
    // Продолжение после диалога лимита подтверждено для этого числа реплик.
    let confirmed = -1;
    for (;;) {
      const key = await this.select({
        title: q.question,
        context: [...(q.why ? [`от ответа зависит: ${q.why}`] : []), ...(history.length ? [`обсуждение: ${replies(history.length)}`] : [])],
        options: [
          ...view.options.map((o, i) => ({ key: String(i), label: o.label, description: o.description })),
          { key: 'own', label: 'Свой ответ…', description: 'ввести ответ текстом' },
          ...(discuss ? [{ key: 'discuss', label: 'Обсудить / уточнить…', description: `спросить ${discuss.role} о вариантах, прежде чем выбрать` }] : []),
        ],
        recommended: String(view.recommended),
        rationale: view.rationale ?? 'вариант, который предложил автор как основной',
      });
      const rec = view.options[view.recommended]!.label;
      if (key === 'own') return { answer: await this.text(q.question, rec), discussion: history };
      if (key !== 'discuss' || !discuss) return { answer: view.options[Number(key)]!.label, discussion: history };
      const n = history.length;
      if (discuss.limit > 0 && n > 0 && n % discuss.limit === 0 && confirmed !== n) {
        const k = await this.select({
          title: `По вопросу уже ${replies(n)} обсуждения`,
          options: [
            { key: 'choose', label: 'Вернуться к выбору варианта' },
            { key: 'continue', label: 'Продолжить обсуждение', description: `ещё ${replies(discuss.limit)} до следующего такого вопроса` },
          ],
          recommended: 'choose',
          rationale: `${replies(n)} (limits.discussTurns: ${discuss.limit}) обычно хватает, чтобы выбрать`,
        });
        if (k === 'choose') continue;
        confirmed = n;
      }
      this.ensureTty(q.question);
      const message = (await paused(() => this.io.input({ message: `Вопрос или комментарий для ${discuss.role}` }))).trim();
      if (message) await this.discussTurn(discuss, message, history, view);
    }
  }

  /** Одна реплика: ответ роли печатается, уточнённые варианты заменяют прежние, неудача в переписку не идёт. */
  private async discussTurn(discuss: Discuss, message: string, history: DiscussTurn[], view: QuestionView): Promise<void> {
    const r = await discuss.reply(message, history, view);
    if ('error' in r) {
      log.warn(`${discuss.role}: ответа на реплику нет (${r.error}) — вопрос остаётся открытым`);
      return;
    }
    const before = JSON.stringify([view.options, view.recommended, view.rationale]);
    if (r.options) {
      view.options = r.options;
      view.recommended = r.recommended ?? 0;
      if (r.rationale) view.rationale = r.rationale;
    }
    const changed = JSON.stringify([view.options, view.recommended, view.rationale]) !== before;
    const t: DiscussTurn = { at: now(), message, answer: r.answer, ...(changed ? { optionsChanged: true } : {}) };
    history.push(t);
    log.discuss(discuss.role, r.answer);
    if (changed) log.step(`варианты обновлены: ${view.options.map((o, i) => (i === view.recommended ? `★ ${o.label}` : o.label)).join(' · ')}`);
    discuss.onTurn(t, view);
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

/** «1 реплика», «2 реплики», «5 реплик». */
export function replies(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  const word = d === 1 && dd !== 11 ? 'реплика' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'реплики' : 'реплик';
  return `${n} ${word}`;
}
