// Режим --auto-until-review: автопилот решает всё до приёмки change, но не снимает блокирующие
// находки (waiver, переход дальше) и паркует run на приёмке. После парковки или BLOCKED решения
// этого run принимает человек — передача пишется в state.json и переживает resume.
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

/** Флаги режима до создания ветки: сообщение об ошибке или undefined. */
export function checkModeFlags(autoApprove: boolean, untilReview: boolean): string | undefined {
  if (autoApprove && untilReview) {
    return '--auto-approve и --auto-until-review несовместимы: первый решает всё, включая приёмку, второй паркует run на приёмке — укажи один';
  }
  return undefined;
}
