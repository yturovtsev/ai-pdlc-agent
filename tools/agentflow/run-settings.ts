// Настройки прогона: какие роли работают, уточнение intent, автопилот. Выключить можно только
// ревьюеров и тестера — без spec-author и implementer нет артефактов и кода.

export const ROLES = ['spec-author', 'spec-reviewer', 'implementer', 'code-reviewer', 'acceptance-tester'] as const;
export type RoleName = (typeof ROLES)[number];
export const REQUIRED: readonly RoleName[] = ['spec-author', 'implementer'];
export const SKIPPABLE: readonly RoleName[] = ROLES.filter((r) => !REQUIRED.includes(r));

export interface RunSettings {
  skip: RoleName[];
  clarify: boolean;
  autoApprove: boolean;
}

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
  return [...new Set(names as RoleName[])];
}

export const CLARIFY = 'clarify';
export const AUTO = 'auto-approve';

export interface MenuItem {
  value: string;
  name: string;
  checked: boolean;
  disabled?: string;
}

/** Пункты меню настроек: роли в порядке конвейера, затем уточнение intent и автопилот. */
export function settingsMenu(o: RunSettings): MenuItem[] {
  return [
    ...ROLES.map((r) => ({
      value: r,
      name: r,
      checked: !o.skip.includes(r),
      ...(REQUIRED.includes(r) ? { disabled: 'обязательная роль' } : {}),
    })),
    { value: CLARIFY, name: 'Уточнение intent (вопросы spec-author до спеки)', checked: o.clarify },
    { value: AUTO, name: 'Автопилот (решения человека — рекомендуемые варианты)', checked: o.autoApprove },
  ];
}

/** Итог меню. Обязательные роли включены всегда: терминал может не вернуть недоступные пункты. */
export function fromMenu(selected: string[]): RunSettings {
  return {
    skip: SKIPPABLE.filter((r) => !selected.includes(r)),
    clarify: selected.includes(CLARIFY),
    autoApprove: selected.includes(AUTO),
  };
}

const STEPS: Record<string, string> = {
  'spec-reviewer': 'ревью артефактов, сквозное ревью',
  'code-reviewer': 'ревью батчей, финальное ревью (остаются полные гейты)',
  'acceptance-tester': 'acceptance',
};

/** Что пропускается из-за выключенных ролей — для лога и отчёта. */
export function skippedSteps(skip: readonly string[]): string[] {
  return skip.map((r) => `${r}: ${STEPS[r] ?? '—'}`);
}
