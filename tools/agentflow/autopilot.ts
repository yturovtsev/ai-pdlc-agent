// Режим --auto-until-review: автопилот решает всё до приёмки change, но не выбирает waiver и
// переход дальше и паркует run на приёмке. После парковки или BLOCKED решения этого run принимает
// человек — передача пишется в state.json и переживает resume. Петли спеки на любом автопилоте
// проходят по лимиту раундов policy (autopilotStep).
import type { RunState } from './state.ts';

/** Решения выбирает автопилот: --auto-approve всегда, режим — до передачи человеку. */
export function autopilotOn(options: Pick<RunState['options'], 'autoApprove' | 'untilReview'>, handover: RunState['handover']): boolean {
  return options.autoApprove || (!!options.untilReview && !handover);
}

/** Выбор автопилота режима вместо рекомендации; undefined — рекомендация как есть. */
export function untilReviewPick(recommended: string): { key: 'more'; why: string } | undefined {
  if (recommended !== 'waive') return undefined;
  return { key: 'more', why: 'режим --auto-until-review: находки critical/major автопилот не снимает — ещё раунд вместо waiver' };
}

/**
 * Шаг петли спеки на автопилоте после раунда с находками. Лимит policy — жёсткий: раунды ревью не
 * продлеваются, после последнего автор делает одну правку, и петля проходит без повторного ревью.
 * Иначе ревьюер и автор создают друг другу работу без конца (вопросы, контекст, новые находки).
 */
export function autopilotStep(round: number, max: number): 'round' | 'final' {
  return round < max ? 'round' : 'final';
}

/** Причина прохода петли спеки автопилотом: в state.json, лог и ACCEPTANCE.md. */
export function budgetPassReason(limit: 'artifactRounds' | 'holisticRounds', max: number): string {
  const what = limit === 'artifactRounds' ? 'последняя правка spec-author' : 'последние правки артефактов';
  return `автопилот: раунды ревью исчерпаны (limits.${limit} = ${max}) — ${what} без повторного ревью`;
}

/** Флаги режима до создания ветки: сообщение об ошибке или undefined. */
export function checkModeFlags(autoApprove: boolean, untilReview: boolean): string | undefined {
  if (autoApprove && untilReview) {
    return '--auto-approve и --auto-until-review несовместимы: первый решает всё, включая приёмку, второй паркует run на приёмке — укажи один';
  }
  return undefined;
}
