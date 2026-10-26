// Диалоги, в которых run может остановиться: хвост меню «Остановить run» и «Всё равно перейти
// дальше». Переход дальше проходит петлю, в которой открыт диалог: петля кладёт свою область в стек,
// диалог бросает PassLoop, петля ловит его и закрывается решением человека. Так диалоги глубоко
// внутри вызова роли (серия сбоев CLI, простой) не знают, какую петлю они проходят.
import type { Choice, Human, Option } from './human.ts';
import { Blocked } from './util.ts';

export const STOP = 'stop';
export const PROCEED = 'proceed';

/** Петля, которую можно пройти решением человека. */
export interface PassScope {
  /** clarify, artifact:<id>, holistic, batch:<id>, acceptance, final, reply. */
  loop: string;
  /** Что произойдёт: «считать батч 2 выполненным → батч 3». */
  label: string;
  /** Причина, по которой перейти нельзя; undefined — можно. */
  check?: () => Promise<string | undefined> | string | undefined;
}

/** Человек выбрал «Всё равно перейти дальше»: ловит петля его области. */
export class PassLoop extends Error {
  constructor(
    readonly scope: PassScope,
    readonly reason: string,
  ) {
    super(`${scope.loop}: пройдено решением человека — ${reason}`);
    this.name = 'PassLoop';
  }
}

export class Scopes {
  private readonly stack: PassScope[] = [];

  top(): PassScope | undefined {
    return this.stack.at(-1);
  }

  /**
   * Выполнить петлю в её области: PassLoop этой области закрывает петлю через onPass, чужой
   * уходит дальше. Область снимается до onPass — закрытие петли уже вне неё.
   */
  async passable<T>(scope: PassScope, fn: () => Promise<T>, onPass: (reason: string) => Promise<T> | T): Promise<T> {
    let reason: string;
    this.stack.push(scope);
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof PassLoop) || e.scope !== scope) throw e;
      reason = e.reason;
    } finally {
      this.stack.splice(this.stack.lastIndexOf(scope), 1);
    }
    return onPass(reason);
  }
}

export interface AskOptions {
  scopes: Scopes;
  /** Точка fault injection: true — сработала (один раз за run). */
  inject?: (point: string) => boolean;
  /** Причина перехода по Enter. */
  defaultReason?: string;
  /** Диалог, который закрывается извне (вмешательство: сессия ожила). */
  signal?: AbortSignal;
}

const STOP_OPTION: Option = { key: STOP, label: 'Остановить run (BLOCKED, потом resume)' };

/**
 * Меню диалога с остановкой: варианты вызывающего, обсуждение (Human), затем «Остановить run» и
 * последним — переход дальше по верхней области. Вариант с ключом stop вызывающего встаёт в хвост
 * со своим описанием. Возвращает выбранный ключ; переход дальше бросает PassLoop, отмена — undefined.
 */
export async function askHuman<K extends string>(human: Human, ch: Choice<K>, o: AskOptions): Promise<K | undefined> {
  if (ch.recommended === (PROCEED as K)) throw new Error(`${ch.title}: переход дальше не может быть рекомендован`);
  const scope = o.scopes.top();
  const own = ch.options.find((x) => x.key === STOP);
  const tail: Option[] = [{ ...STOP_OPTION, ...own }];
  let disabled: string | undefined;
  if (scope) {
    disabled = await scope.check?.();
    tail.push({ key: PROCEED, label: `Всё равно перейти дальше: ${scope.label}`, description: 'нужна причина; петля засчитывается решением человека', ...(disabled ? { disabled } : {}) });
  }
  // Автопилот переходит дальше только по точке inject и только если пункт доступен.
  const injected = !!scope && !disabled && human.auto && !!o.inject?.(`proceed:${scope.loop}`);
  const menu: Choice<string> = {
    ...ch,
    options: ch.options.filter((x) => x.key !== STOP),
    tail: [...(ch.tail ?? []), ...tail],
    ...(injected ? { autoPick: { key: PROCEED, why: `fault injection proceed:${scope!.loop}` } } : {}),
  };
  const k = o.signal ? await human.selectOrCancel(menu, o.signal) : await human.select(menu);
  if (k !== PROCEED) return k as K | undefined;
  const reason = await human.text('Причина перехода дальше', injected ? 'fault injection' : (o.defaultReason ?? 'решение человека: перейти дальше без PASS'));
  throw new PassLoop(scope!, reason);
}

/**
 * Диалог блокера роли вместо остановки: дать контекст и повторить шаг, обсуждение (decorate
 * добавляет его к меню), «Остановить run» и переход дальше. Рекомендуется остановка — автопилот
 * ведёт себя, как до диалога: run в BLOCKED с причиной вердикта.
 */
export async function blocker(
  human: Human,
  b: { title: string; reason: string; context?: string[]; retry?: string; decorate?: (ch: Choice<'context' | 'stop'>) => Choice<'context' | 'stop'> },
  o: AskOptions,
): Promise<'context'> {
  const ch: Choice<'context' | 'stop'> = {
    title: b.title,
    context: [`причина: ${b.reason}`, ...(b.context ?? [])],
    options: [
      { key: 'context', label: b.retry ?? 'Дать недостающий контекст и повторить шаг', description: 'текст попадёт в уточнения intent — его увидят все роли' },
      { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)', description: 'устранить причину и продолжить командой resume' },
    ],
    recommended: 'stop',
    rationale: 'роль не может продолжить без человека — остановка сохраняет поведение без диалога; resume продолжит этот шаг',
  };
  const k = await askHuman(human, b.decorate ? b.decorate(ch) : ch, o);
  if (k === 'stop') throw new Blocked(b.reason);
  return 'context';
}
