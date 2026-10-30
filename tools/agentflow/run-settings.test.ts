// Unit-тесты настроек прогона: разбор --skip-roles, пункты меню, их проверка и итог, отчёт run только со спекой.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalReviewPrompt } from './context-builder.ts';
import { writeAcceptanceReport } from './report.ts';
import type { RunState } from './state.ts';
import { Human, type CheckItem, type PromptIO } from './human.ts';
import { fromMenu, parseSkipRoles, settingsMenu, skippedSteps, specOnly, validateMenu, type RunSettings } from './run-settings.ts';

const BASE: RunSettings = { skip: [], clarify: true, autoApprove: false, untilReview: false, panel: true, mouse: true, worktree: false };

test('--skip-roles: выключается всё, кроме spec-author; без implementer — и роли кода', () => {
  assert.deepEqual(parseSkipRoles('code-reviewer, acceptance-tester,code-reviewer'), ['code-reviewer', 'acceptance-tester']);
  assert.deepEqual(parseSkipRoles(undefined), []);
  assert.deepEqual(parseSkipRoles('implementer'), ['implementer', 'code-reviewer', 'acceptance-tester']);
  assert.deepEqual(parseSkipRoles('implementer,spec-reviewer'), ['spec-reviewer', 'implementer', 'code-reviewer', 'acceptance-tester']);
  assert.throws(() => parseSkipRoles('spec-author'), /spec-author — обязательная роль\. Выключить можно: spec-reviewer, implementer, code-reviewer, acceptance-tester/);
  assert.throws(() => parseSkipRoles('reviewer'), /reviewer — нет такой роли/);
  assert.ok(specOnly(parseSkipRoles('implementer')) && !specOnly(parseSkipRoles('code-reviewer')));
});

test('меню настроек: обязательный только spec-author, флаги задают начальные галочки', () => {
  const m = settingsMenu({ ...BASE, skip: ['code-reviewer'], clarify: false, autoApprove: true, mouse: false });
  assert.deepEqual(m.map((x) => x.value), ['spec-author', 'spec-reviewer', 'implementer', 'code-reviewer', 'acceptance-tester', 'clarify', 'auto-approve', 'auto-until-review', 'panel', 'mouse', 'worktree']);
  assert.deepEqual(m.filter((x) => x.disabled).map((x) => [x.value, x.checked, x.disabled]), [['spec-author', true, 'обязательная роль']]);
  assert.deepEqual(m.filter((x) => !x.checked).map((x) => x.value), ['code-reviewer', 'clarify', 'auto-until-review', 'mouse', 'worktree']);
  assert.ok(m.every((x) => x.description), 'у каждого пункта подсказка');
  assert.deepEqual(fromMenu(['spec-reviewer', 'implementer', 'acceptance-tester', 'auto-approve', 'panel']), { skip: ['code-reviewer'], clarify: false, autoApprove: true, untilReview: false, panel: true, mouse: false, worktree: false });
  assert.equal(fromMenu(['worktree']).worktree, true);
  assert.deepEqual(skippedSteps(['spec-reviewer']), ['spec-reviewer: ревью артефактов, сквозное ревью']);
});

test('меню настроек: без implementer — run только со спекой, роли кода выключаются с ним', () => {
  const r = fromMenu(['spec-reviewer', 'code-reviewer', 'acceptance-tester', 'clarify']);
  assert.deepEqual(r.skip, ['implementer', 'code-reviewer', 'acceptance-tester']);
  assert.ok(specOnly(r.skip));
  assert.deepEqual(skippedSteps(r.skip), ['implementer: apply, acceptance, финальное ревью и archive — run завершается на freeze спеки']);
});

test('меню настроек: два автопилота не выбираются вместе, AGENTFLOW_NO_* делает пункт недоступным', () => {
  assert.equal(validateMenu(['auto-approve']), true);
  assert.equal(validateMenu(['auto-until-review', 'panel']), true);
  assert.match(String(validateMenu(['auto-approve', 'auto-until-review'])), /несовместимы/);
  const m = settingsMenu(BASE, { AGENTFLOW_NO_PANEL: '1' });
  const view = m.filter((x) => x.value === 'panel' || x.value === 'mouse').map((x) => [x.value, x.checked, x.disabled]);
  assert.deepEqual(view, [['panel', false, 'AGENTFLOW_NO_PANEL=1'], ['mouse', true, undefined]]);
  assert.equal(fromMenu(m.filter((x) => x.checked).map((x) => x.value)).panel, false);
});

test('меню с галочками: пункты с checked, disabled и validate уходят в терминал, автопилот берёт исходные', async () => {
  const seen: CheckItem[][] = [];
  let check: ((c: readonly { value: string }[]) => true | string) | undefined;
  const io: PromptIO = {
    select: async () => '',
    input: async () => '',
    checkbox: async (c) => (seen.push(c.choices), (check = c.validate), ['spec-reviewer', 'implementer', 'acceptance-tester']),
    tty: () => true,
  };
  const items = settingsMenu(BASE);
  const picked = await new Human(false, io).checklist('Настройки run', items, validateMenu);
  assert.equal(seen[0]!.find((i) => i.value === 'spec-author')!.disabled, 'обязательная роль');
  assert.match(String(check!([{ value: 'auto-approve' }, { value: 'auto-until-review' }])), /несовместимы/);
  assert.deepEqual(fromMenu(picked), { skip: ['code-reviewer'], clarify: false, autoApprove: false, untilReview: false, panel: false, mouse: false, worktree: false });
  assert.ok(picked.includes('spec-author'), 'недоступные отмеченные остаются');
  const auto = await new Human(true, { ...io, checkbox: async () => assert.fail('автопилот не открывает меню') }).checklist('t', items);
  assert.deepEqual(fromMenu(auto), BASE);
});

test('промпт финального ревью без acceptance-tester: вместо отчёта — строка о выключенной роли', () => {
  const base = { change: 'add-slugify', changeDir: 'openspec/changes/add-slugify', intent: 'slugify', clarifications: [] };
  const a = {
    round: 1,
    max: 3,
    reqs: [],
    specFiles: ['openspec/changes/add-slugify/specs/text-slug/spec.md'],
    diffPath: 'final-r1.diff',
    base: 'a',
    head: 'b',
    gates: 'lint: зелёный',
    acceptancePath: 'contexts/acceptance-report.json',
    acceptanceDir: 'e2e',
    rubric: { name: 'final', path: 'final.md', text: '', mandatory: [] },
    snapshotId: 's',
    prior: [],
  };
  const off = finalReviewPrompt(base, { ...a, acceptanceOff: true });
  assert.match(off, /acceptance-tester выключен в настройках run/);
  assert.doesNotMatch(off, /acceptance-report\.json/);
  assert.match(finalReviewPrompt(base, a), /отчёт acceptance-tester: contexts\/acceptance-report\.json/);
});

test('отчёт приёмки: раздел «Настройки прогона» и финал по гейтам', () => {
  const s = {
    runId: 'r',
    change: 'add-slugify',
    status: 'running',
    branch: 'b',
    worktree: '/wt',
    baseCommit: 'abcdef1234',
    options: { autoApprove: true, mock: true, clarify: false, inject: [], skip: ['spec-reviewer', 'code-reviewer'] },
    spec: {},
    final: { status: 'GATES_ONLY', snapshot: 's', rounds: 1, traceability: [] },
    loops: [],
    gates: [],
    findings: [],
    models: {},
    usage: {},
    decisions: [],
    proceeded: [],
    dialogs: {},
  } as unknown as RunState;
  const md = readFileSync(writeAcceptanceReport(mkdtempSync(join(tmpdir(), 'agentflow-settings-')), s, ''), 'utf8');
  assert.match(md, /## Настройки прогона\n\n- выключены роли: spec-reviewer, code-reviewer\n- пропущено — spec-reviewer: ревью артефактов, сквозное ревью\n- пропущено — code-reviewer: ревью батчей/);
  assert.match(md, /уточнение intent: нет · автопилот: да/);
  assert.match(md, /ревью кода выключено в настройках run/);
});

test('отчёт run только со спекой: implementer выключен, трассировки нет, ручная проверка — чтение спеки', () => {
  const s = {
    runId: 'r',
    change: 'add-slugify',
    status: 'accepted',
    branch: 'b',
    worktree: '/wt',
    repoRoot: '/repo',
    baseCommit: 'abcdef1234',
    options: { autoApprove: false, mock: true, clarify: true, inject: [], skip: ['implementer', 'code-reviewer', 'acceptance-tester'] },
    spec: { freeze: { digest: 'd', at: 't', commit: 'c' } },
    loops: [],
    gates: [],
    findings: [],
    models: {},
    usage: {},
    decisions: [],
    proceeded: [],
    dialogs: {},
  } as unknown as RunState;
  const md = readFileSync(writeAcceptanceReport(mkdtempSync(join(tmpdir(), 'agentflow-settings-')), s, ''), 'utf8');
  assert.match(md, /- пропущено — implementer: apply, acceptance, финальное ревью и archive — run завершается на freeze спеки\n- уточнение/);
  assert.match(md, /implementer выключен — run только со спекой, кода и трассировки нет/);
  assert.match(md, /прочитай спеку: \/wt\/openspec\/changes\/add-slugify; код — agentflow run --change add-slugify/);
});
