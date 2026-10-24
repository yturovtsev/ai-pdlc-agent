// Искусственные сбои: гарантированно проводят прогон через каждую петлю конвейера,
// даже когда модели всё делают с первого раза. Каждая точка срабатывает один раз за run.
import { log } from './log.ts';
import type { RunStore } from './state.ts';

export const INJECT_ALL = [
  'review-bad-json', // битый JSON первого ревьюера → валидатор контракта → новый экземпляр ревьюера
  'artifact-revise:proposal', // REVISE первого ревью proposal → петля артефакта
  'holistic-revise', // REVISE сквозного ревью → исправление артефакта и повторное ревью downstream
  'gate-red:1', // красный гейт батча 1 → петля «гейты → implementer»
  'batch-revise:1', // REVISE ревью батча 1 → раунд исправлений в той же сессии implementer
  'final-revise', // REVISE финального ревью → исправление через implementer, гейты и ревью заново
  'artifact-stuck:specs', // одна и та же находка все автоматические раунды → диалог «лимит исчерпан»
  'batch-stuck:2', // то же для task batch 2 в apply
  'stall:implementer', // первая сессия implementer молчит → сторож простоя, диалог вмешательства, повтор шага
  'discuss-question', // первый вопрос с вариантами: автопилот задаёт реплику обсуждения → сессия роли только на чтение
];

export const INJECT_HELP = [
  ...INJECT_ALL.filter((p) => !p.startsWith('stall:')),
  'stall:<роль> — первая сессия роли молчит, пока сторож её не прервёт (в mock порог 2 с)',
  'kill-after:<stage> — убить контроллер после этапа (проверка resume)',
];

export function parseInject(arg: string | undefined): string[] {
  if (!arg) return [];
  return arg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => (s === 'all' ? INJECT_ALL : [s]));
}

export class Injector {
  constructor(private readonly store: RunStore) {}

  take(point: string): boolean {
    const s = this.store.state;
    if (!s.options.inject.includes(point) || s.injected.includes(point)) return false;
    s.injected.push(point);
    this.store.save();
    log.inject(point);
    return true;
  }

  /** Точка срабатывает times раз подряд (имитация автора, который не сходится). */
  repeat(point: string, times: number): boolean {
    const s = this.store.state;
    if (!s.options.inject.includes(point)) return false;
    const counts = (s.injectCounts ??= {});
    if ((counts[point] ?? 0) >= times) return false;
    counts[point] = (counts[point] ?? 0) + 1;
    this.store.save();
    log.inject(`${point} (${counts[point]}/${times})`);
    return true;
  }
}
