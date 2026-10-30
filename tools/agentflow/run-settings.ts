// Настройки прогона: какие роли работают, уточнение intent, автопилот, панель, мышь и дерево run. Выключить нельзя
// только spec-author — без него нет артефактов. Без implementer run только со спекой: он завершается
// на freeze, а code-reviewer и acceptance-tester без кода не нужны и выключаются вместе с ним.

export const ROLES = ['spec-author', 'spec-reviewer', 'implementer', 'code-reviewer', 'acceptance-tester'] as const;
export type RoleName = (typeof ROLES)[number];
export const REQUIRED: readonly RoleName[] = ['spec-author'];
export const SKIPPABLE: readonly RoleName[] = ROLES.filter((r) => !REQUIRED.includes(r));
/** Роли, которым нужен код implementer. */
const CODE_ROLES: readonly RoleName[] = ['code-reviewer', 'acceptance-tester'];

export interface RunSettings {
  skip: RoleName[];
  clarify: boolean;
  autoApprove: boolean;
  untilReview: boolean;
  panel: boolean;
  mouse: boolean;
  /** Run в своём worktree, а не в основном дереве репозитория. */
  worktree: boolean;
}

/** Без implementer выключаются и роли, которым нужен код; порядок — как в конвейере. */
export function normalizeSkip(skip: readonly string[]): RoleName[] {
  const off = new Set(skip);
  if (off.has('implementer')) for (const r of CODE_ROLES) off.add(r);
  return ROLES.filter((r) => off.has(r));
}

/** Run только со спекой: implementer выключен, run завершается на freeze. */
export const specOnly = (skip: readonly string[]): boolean => skip.includes('implementer');

/** --skip-roles a,b: неизвестная или обязательная роль — ошибка с перечнем допустимых. */
export function parseSkipRoles(arg: string | undefined): RoleName[] {
  const names = (arg ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = names.filter((n) => !SKIPPABLE.includes(n as RoleName));
  if (bad.length) {
    const why = bad.map((n) => (REQUIRED.includes(n as RoleName) ? `${n} — обязательная роль` : `${n} — нет такой роли`)).join('; ');
    throw new Error(`--skip-roles: ${why}. Выключить можно: ${SKIPPABLE.join(', ')}`);
  }
  return normalizeSkip(names);
}

export const CLARIFY = 'clarify';
export const AUTO = 'auto-approve';
export const UNTIL_REVIEW = 'auto-until-review';
export const PANEL = 'panel';
export const MOUSE = 'mouse';
export const WORKTREE = 'worktree';

export interface MenuItem {
  value: string;
  name: string;
  checked: boolean;
  disabled?: string;
  description?: string;
}

const ROLE_HINT: Record<RoleName, string> = {
  'spec-author': 'пишет артефакты спеки',
  'spec-reviewer': 'без него артефакт после validate сразу идёт к тебе, сквозного ревью нет',
  implementer: 'без него run только со спекой: завершается на freeze, code-reviewer и acceptance-tester не нужны',
  'code-reviewer': 'без него батч и финал принимаются по зелёным гейтам',
  'acceptance-tester': 'без него этапа acceptance нет',
};

/**
 * Пункты меню: роли в порядке конвейера, затем уточнение intent, автопилоты, панель, мышь и worktree.
 * AGENTFLOW_NO_PANEL=1 и AGENTFLOW_NO_MOUSE=1 в `env` делают пункт недоступным: галочка ничего бы не включила.
 */
export function settingsMenu(o: RunSettings, env: Record<string, string | undefined> = {}): MenuItem[] {
  const envOff = (name: string) => (env[name] === '1' ? { checked: false, disabled: `${name}=1` } : {});
  return [
    ...ROLES.map((r) => ({
      value: r,
      name: r,
      checked: !o.skip.includes(r),
      description: ROLE_HINT[r],
      ...(REQUIRED.includes(r) ? { disabled: 'обязательная роль' } : {}),
    })),
    { value: CLARIFY, name: 'Уточнение intent (вопросы spec-author до спеки)', checked: o.clarify, description: 'флаг --no-clarify снимает галочку' },
    { value: AUTO, name: 'Автопилот (решения человека — рекомендуемые варианты)', checked: o.autoApprove, description: 'флаг --auto-approve: решает всё, включая приёмку и archive' },
    {
      value: UNTIL_REVIEW,
      name: 'Автопилот до приёмки (без waiver, run ждёт тебя на приёмке)',
      checked: o.untilReview,
      description: 'флаг --auto-until-review; вместе с «Автопилотом» не выбирается',
    },
    { value: PANEL, name: 'Панель статуса внизу терминала', checked: o.panel, description: 'флаг --no-panel снимает галочку', ...envOff('AGENTFLOW_NO_PANEL') },
    {
      value: MOUSE,
      name: 'Мышь: клик по «▸ размышляет» раскрывает текст',
      checked: o.mouse,
      description: 'флаг --no-mouse снимает галочку; без мыши работает выделение текста терминалом',
      ...envOff('AGENTFLOW_NO_MOUSE'),
    },
    {
      value: WORKTREE,
      name: 'Отдельный worktree вместо основного дерева',
      checked: o.worktree,
      description: 'флаг --worktree: код и спека — в .agentflow-runs/<run>/worktree; нужен для нескольких run одновременно',
    },
  ];
}

/** Проверка выбора до запуска: true или текст ошибки под меню. */
export function validateMenu(selected: readonly string[]): true | string {
  if (selected.includes(AUTO) && selected.includes(UNTIL_REVIEW)) {
    return 'Автопилот и автопилот до приёмки несовместимы: первый решает всё, включая приёмку, второй ждёт тебя на приёмке — оставь один';
  }
  return true;
}

/** Итог меню. Обязательные роли включены всегда: терминал может не вернуть недоступные пункты. */
export function fromMenu(selected: string[]): RunSettings {
  return {
    skip: normalizeSkip(SKIPPABLE.filter((r) => !selected.includes(r))),
    clarify: selected.includes(CLARIFY),
    autoApprove: selected.includes(AUTO),
    untilReview: selected.includes(UNTIL_REVIEW),
    panel: selected.includes(PANEL),
    mouse: selected.includes(MOUSE),
    worktree: selected.includes(WORKTREE),
  };
}

const STEPS: Record<string, string> = {
  'spec-reviewer': 'ревью артефактов, сквозное ревью',
  implementer: 'apply, acceptance, финальное ревью и archive — run завершается на freeze спеки',
  'code-reviewer': 'ревью батчей, финальное ревью (остаются полные гейты)',
  'acceptance-tester': 'acceptance',
};

/** Что пропускается из-за выключенных ролей — для лога и отчёта. Без implementer роли кода не перечисляются. */
export function skippedSteps(skip: readonly string[]): string[] {
  const shown = specOnly(skip) ? skip.filter((r) => !CODE_ROLES.includes(r as RoleName)) : skip;
  return shown.map((r) => `${r}: ${STEPS[r] ?? '—'}`);
}
