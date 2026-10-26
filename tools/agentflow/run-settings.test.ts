// Unit-тесты настроек прогона: разбор --skip-roles, пункты меню и их итог.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalReviewPrompt } from './context-builder.ts';
import { writeAcceptanceReport } from './report.ts';
import type { RunState } from './state.ts';
import { Human, type CheckItem, type PromptIO } from './human.ts';
import { fromMenu, parseSkipRoles, settingsMenu, skippedSteps } from './run-settings.ts';

test('--skip-roles: ревьюеры и тестер выключаются, обязательные и неизвестные — ошибка', () => {
  assert.deepEqual(parseSkipRoles('code-reviewer, acceptance-tester,code-reviewer'), ['code-reviewer', 'acceptance-tester']);
  assert.deepEqual(parseSkipRoles(undefined), []);
  assert.throws(() => parseSkipRoles('implementer'), /implementer — обязательная роль\. Выключить можно: spec-reviewer, code-reviewer, acceptance-tester/);
  assert.throws(() => parseSkipRoles('reviewer'), /reviewer — нет такой роли/);
});

test('меню настроек: обязательные отмечены и недоступны, флаги задают начальные галочки', () => {
  const m = settingsMenu({ skip: ['code-reviewer'], clarify: false, autoApprove: true });
  assert.deepEqual(m.map((x) => x.value), ['spec-author', 'spec-reviewer', 'implementer', 'code-reviewer', 'acceptance-tester', 'clarify', 'auto-approve']);
  assert.deepEqual(m.filter((x) => x.disabled).map((x) => [x.value, x.checked, x.disabled]), [['spec-author', true, 'обязательная роль'], ['implementer', true, 'обязательная роль']]);
  assert.deepEqual(m.filter((x) => !x.checked).map((x) => x.value), ['code-reviewer', 'clarify']);
  assert.deepEqual(fromMenu(['spec-reviewer', 'acceptance-tester', 'auto-approve']), { skip: ['code-reviewer'], clarify: false, autoApprove: true });
  assert.deepEqual(skippedSteps(['spec-reviewer']), ['spec-reviewer: ревью артефактов, сквозное ревью']);
});

test('меню с галочками: пункты с checked и disabled уходят в терминал, автопилот берёт исходные', async () => {
  const seen: CheckItem[][] = [];
  const io: PromptIO = {
    select: async () => '',
    input: async () => '',
    checkbox: async (c) => (seen.push(c.choices), ['spec-reviewer', 'acceptance-tester']),
    tty: () => true,
  };
  const items = settingsMenu({ skip: [], clarify: true, autoApprove: false });
  const picked = await new Human(false, io).checklist('Настройки run', items);
  assert.equal(seen[0]!.find((i) => i.value === 'implementer')!.disabled, 'обязательная роль');
  assert.deepEqual(fromMenu(picked), { skip: ['code-reviewer'], clarify: false, autoApprove: false });
  assert.ok(picked.includes('implementer') && picked.includes('spec-author'), 'недоступные отмеченные остаются');
  const auto = await new Human(true, { ...io, checkbox: async () => assert.fail('автопилот не открывает меню') }).checklist('t', items);
  assert.deepEqual(fromMenu(auto), { skip: [], clarify: true, autoApprove: false });
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
