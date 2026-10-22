// Вмешательство в работающую сессию роли: простой или серия отказов ACL. Здесь только тексты и
// рекомендация — чистые функции; сторож живёт в roles.ts, диалог открывает контроллер.
import { clockTime } from './log.ts';
import type { TrackedDenial, TrackerStep } from './session-tracker.ts';
import { clock } from './status-panel.ts';

export type InterventionKind = 'stall' | 'acl-streak';
/** woke — диалог закрыт без выбора: сессия ожила сама. */
export type InterventionDecision = 'wait' | 'retry' | 'stop' | 'woke';
export type InterventionChoice = Exclude<InterventionDecision, 'woke'>;

export interface Intervention {
  kind: InterventionKind;
  role: string;
  step: TrackerStep;
  idleMs: number;
  /** Отказы текущей серии (для acl-streak). */
  denials: TrackedDenial[];
}

export interface InterventionOutcome {
  kind: InterventionKind;
  decision: 'retry' | 'stop';
  denials: TrackedDenial[];
  message: string;
}

/** Отказы серии без повторов: «tool цель — причина ×N». */
function denialLines(denials: TrackedDenial[]): string[] {
  const counts = new Map<string, number>();
  for (const d of denials) {
    const k = `${d.tool} ${d.target} — ${d.reason}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
}

/** Что произошло — строка предупреждения в логе и заголовок диалога. */
export function diagnose(ev: Intervention): string {
  if (ev.kind === 'stall') {
    return `${ev.role}: нет событий от сессии ${clock(ev.idleMs)} — последнее: ${ev.step.label} с ${clockTime(ev.step.since)}`;
  }
  return `${ev.role}: роль упирается в ACL — ${ev.denials.length} отказов подряд: ${denialLines(ev.denials).join('; ')}`;
}

/** Ошибка шага, когда сессию прервали по решению о вмешательстве. */
export function interventionError(ev: Intervention): string {
  return ev.kind === 'stall'
    ? `простой роли ${clock(ev.idleMs)} на шаге «${ev.step.label}» — сессия прервана`
    : `роль упиралась в ACL (${ev.denials.length} отказов подряд) — сессия прервана`;
}

/**
 * Рекомендация. Простой: первый — ждать (модель на высоком effort и гейт внутри сессии бывают долгими),
 * второй — повторить, дальше — стоп, чтобы --auto-approve не ждал вечно. Серия ACL: если роли не хватает
 * разрешения, помочь может только правка policy.
 */
export function recommendIntervention(ev: Intervention, nth: number): { choice: InterventionChoice; rationale: string } {
  if (ev.kind === 'acl-streak') {
    const need = ev.denials.find((d) => d.category === 'permission');
    if (need) return { choice: 'stop', rationale: `роли не хватает разрешения — поправь policy и продолжи resume: ${need.hint}` };
    return { choice: 'retry', rationale: 'все отказы ожидаемые: новая сессия получит в промпте список запретов и того, что разрешено' };
  }
  if (nth <= 1) return { choice: 'wait', rationale: 'ответ модели на высоком effort и гейт внутри сессии бывают долгими — первый простой стоит переждать' };
  if (nth === 2) return { choice: 'retry', rationale: 'сессия молчит второй порог подряд — новая сессия дешевле дальнейшего ожидания' };
  return { choice: 'stop', rationale: `простой №${nth} в этом шаге: повтор тоже завис, причина устойчивая (CLI, модель, гейт) — её нужно устранить` };
}

export const INTERVENTION_OPTIONS: { key: InterventionChoice; label: string; description: string }[] = [
  { key: 'wait', label: 'Ждать дальше', description: 'сессия продолжает работать, сторож отсчитывает порог заново' },
  { key: 'retry', label: 'Прервать сессию и повторить шаг', description: 'та же задача новой сессией роли (попытка серии повторов)' },
  { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)', description: 'сессия прерывается; устрани причину и продолжи командой resume' },
];

/** Раздел промпта следующей попытки после серии отказов ACL: что отклонено и что разрешено. */
export function aclRetryAddendum(denials: TrackedDenial[]): string {
  const allowed = [...new Set(denials.map((d) => d.allowed).filter((a): a is string => !!a))];
  return [
    '## Предыдущая попытка прервана: роль упиралась в ACL',
    'Эти вызовы контроллер отклонил, повторять их бессмысленно:',
    ...denialLines(denials).map((l) => `- ${l}`),
    '',
    'Разрешено:',
    ...allowed.map((a) => `- ${a}`),
    '',
    'Сделай задачу только разрешёнными средствами. Если без запрещённого действия задачу не выполнить, верни ответ по контракту и опиши, что мешает.',
  ].join('\n');
}
