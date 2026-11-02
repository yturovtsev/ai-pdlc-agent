// Unit-тесты режима --auto-until-review: включён ли автопилот, выбор вместо waiver, флаги,
// автопилот режима в диалогах и отметка в логе; лимит раундов спеки на любом автопилоте.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autopilotOn, autopilotStep, budgetPassReason, checkModeFlags, untilReviewPick } from './autopilot.ts';
import { askHuman, Scopes, type PassScope } from './dialogs.ts';
import { Human, type Choice } from './human.ts';
import { stripAnsi } from './status-panel.ts';
import { writeAcceptanceReport } from './report.ts';
import { RunStore, type RunState } from './state.ts';

/** Строки console.log за время fn — без цветов. */
async function printed<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(stripAnsi(a.map(String).join(' ')));
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = orig;
  }
}

test('state.json без режима загружается: untilReview и handover нет — автопилот по autoApprove', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-autopilot-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ runId: 'r', decisions: [], findings: [], options: { autoApprove: false } }));
  const s = new RunStore(dir).load();
  assert.equal(s.options.untilReview, undefined);
  assert.equal(s.handover, undefined);
  assert.equal(autopilotOn(s.options, s.handover), false);
});

test('autopilotOn: --auto-approve всегда, режим — до передачи человеку', () => {
  const handover = { at: '2026-10-27T00:00:00Z', reason: 'парковка на приёмке' };
  assert.equal(autopilotOn({ autoApprove: false }, undefined), false);
  assert.equal(autopilotOn({ autoApprove: true }, undefined), true);
  assert.equal(autopilotOn({ autoApprove: true }, handover), true);
  assert.equal(autopilotOn({ autoApprove: false, untilReview: true }, undefined), true);
  assert.equal(autopilotOn({ autoApprove: false, untilReview: true }, handover), false);
});

test('untilReviewPick: waiver → ещё раунд с причиной, остальное — как рекомендовано', () => {
  const p = untilReviewPick('waive');
  assert.equal(p?.key, 'more');
  assert.match(p!.why, /critical\/major/);
  for (const k of ['more', 'hint', 'stop', 'fresh']) assert.equal(untilReviewPick(k), undefined);
});

test('checkModeFlags: оба флага — ошибка с обоими именами', () => {
  assert.equal(checkModeFlags(false, false), undefined);
  assert.equal(checkModeFlags(true, false), undefined);
  assert.equal(checkModeFlags(false, true), undefined);
  const m = checkModeFlags(true, true)!;
  assert.match(m, /--auto-approve/);
  assert.match(m, /--auto-until-review/);
});

const exhausted: Choice<'more' | 'stop'> = {
  title: 'batch 1: 3 автоматических раунда без PASS',
  options: [
    { key: 'more', label: 'Ещё раунд' },
    { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)' },
  ],
  recommended: 'more',
  rationale: 'находки меняются',
};
const batch1: PassScope = { loop: 'batch:1', label: 'считать батч 1 выполненным → батч 2' };

test('автопилот режима: точка proceed:<петля> берётся, но перехода дальше нет; обычный автопилот переходит', async () => {
  const scopes = new Scopes();
  const taken: string[] = [];
  const inject = (p: string) => (taken.includes(p) ? false : (taken.push(p), true));
  const strict = new Human(true, undefined, true);
  const r = await printed(() => scopes.passable(batch1, () => askHuman(strict, exhausted, { scopes, inject }), () => 'passed'));
  assert.equal(r.value, 'more');
  assert.deepEqual(taken, ['proceed:batch:1'], 'точка потрачена — в следующем диалоге петли не всплывёт');
  assert.ok(r.lines.some((l) => l.includes('переход дальше по proceed:batch:1 пропущен')));
  assert.ok(r.lines.some((l) => l.includes('(--auto-until-review) → Ещё раунд')));
  taken.length = 0;
  const plain = await printed(() => scopes.passable(batch1, () => askHuman(new Human(true), exhausted, { scopes, inject }), (why) => `passed: ${why}`));
  assert.equal(plain.value, 'passed: fault injection');
});

test('автопилот режима: «Остановить» на третьем исчерпании выбирается как есть', async () => {
  const scopes = new Scopes();
  const r = await printed(() => scopes.passable(batch1, () => askHuman(new Human(true, undefined, true), { ...exhausted, recommended: 'stop' }, { scopes }), () => 'passed'));
  assert.equal(r.value, 'stop');
});

test('отметка в логе: режим — (--auto-until-review), --auto-approve — прежняя', async () => {
  const strict = await printed(async () => [await new Human(true, undefined, true).select(exhausted), await new Human(true, undefined, true).text('Причина', 'по умолчанию')]);
  assert.deepEqual(strict.value, ['more', 'по умолчанию']);
  assert.ok(strict.lines.some((l) => l.includes('(--auto-until-review) → Ещё раунд')));
  assert.ok(strict.lines.some((l) => l.includes('(--auto-until-review) → по умолчанию')));
  assert.ok(!strict.lines.some((l) => l.includes('--auto-approve')));
  const plain = await printed(() => new Human(true).select(exhausted));
  assert.ok(plain.lines.some((l) => l.includes('(--auto-approve) → Ещё раунд')));
});

function reportOf(over: Partial<RunState>): string {
  const s = {
    runId: 'r',
    change: 'add-slugify',
    status: 'running',
    branch: 'b',
    worktree: '/wt',
    baseCommit: 'abcdef1234',
    options: { autoApprove: false, mock: true, clarify: true, inject: [], skip: [] },
    spec: {},
    loops: [],
    gates: [],
    findings: [],
    models: {},
    usage: {},
    decisions: [],
    proceeded: [],
    dialogs: {},
    ...over,
  } as unknown as RunState;
  return readFileSync(writeAcceptanceReport(mkdtempSync(join(tmpdir(), 'agentflow-mode-')), s, ''), 'utf8');
}

test('отчёт приёмки: запаркованный run режима — шапка и раздел «Режим прогона» со счётчиками', () => {
  const at = '2026-10-27T01:00:00.000Z';
  const md = reportOf({
    status: 'awaiting-review',
    options: { autoApprove: false, mock: true, clarify: true, inject: [], skip: [], untilReview: true },
    handover: { at, reason: 'парковка на приёмке' },
    decisions: [
      { at: '2026-10-27T00:10:00.000Z', gate: 'artifact:proposal', decision: 'accepted' },
      { at: '2026-10-27T00:20:00.000Z', gate: 'approval', decision: 'approved' },
      { at: '2026-10-27T02:00:00.000Z', gate: 'acceptance', decision: 'accepted' },
    ],
    findings: [{ id: 'SR-1', severity: 'minor', status: 'logged', step: 'artifact:proposal', problem: 'p', location: 'l' }] as unknown as RunState['findings'],
  });
  assert.match(md, /Статус конвейера: \*\*ждёт ревью человека\*\*/);
  assert.match(md, /автопилот: до приёмки \(--auto-until-review\)/);
  assert.match(md, /## Режим прогона\n/);
  assert.match(md, /- решений автопилота: 2\n/, 'решение после передачи — человека');
  assert.match(md, new RegExp(`- решения переданы человеку: ${at} — парковка на приёмке`));
  assert.match(md, /- открытых находок critical и major: 0\n/);
  assert.match(md, /- waiver: 0 · переходов дальше: 0/);
});

test('отчёт приёмки: открытая major в режиме названа; без режима раздела нет', () => {
  const md = reportOf({
    options: { autoApprove: false, mock: true, clarify: true, inject: [], skip: [], untilReview: true },
    findings: [{ id: 'CR-2', severity: 'major', status: 'open', step: 'batch:1', problem: 'p', location: 'l' }] as unknown as RunState['findings'],
  });
  assert.match(md, /- решения переданы человеку: нет/);
  assert.match(md, /- открытых находок critical и major: 1 \(CR-2\)/);
  const plain = reportOf({ options: { autoApprove: true, mock: true, clarify: true, inject: [], skip: [] } });
  assert.ok(!plain.includes('Режим прогона'));
  assert.match(plain, /автопилот: да/);
});

test('autopilotStep: лимит раундов policy жёсткий — после последнего ревью одна правка без ревью', () => {
  assert.equal(autopilotStep(1, 1), 'final', 'artifactRounds = 1: ревью, правка автора, дальше');
  assert.equal(autopilotStep(1, 3), 'round');
  assert.equal(autopilotStep(2, 3), 'round');
  assert.equal(autopilotStep(3, 3), 'final');
  assert.equal(autopilotStep(4, 3), 'final', 'раунд сверх лимита (диалог исчерпания после неудачной правки) — тоже без ревью');
});

test('budgetPassReason называет ключ policy и его значение', () => {
  assert.equal(budgetPassReason('artifactRounds', 1), 'автопилот: раунды ревью исчерпаны (limits.artifactRounds = 1) — последняя правка spec-author без повторного ревью');
  assert.match(budgetPassReason('holisticRounds', 2), /limits\.holisticRounds = 2\) — последние правки артефактов без повторного ревью/);
});

test('отчёт приёмки: петли, пройденные автопилотом по лимиту, — отдельным разделом, не «решением человека»', () => {
  const reason = budgetPassReason('artifactRounds', 1);
  const md = reportOf({
    options: { autoApprove: false, mock: true, clarify: true, inject: [], skip: [], untilReview: true },
    proceeded: [
      { at: 't1', loop: 'artifact:specs', label: 'принять «specs» как есть → «design»', reason, findings: ['SR-3'], by: 'autopilot' },
      { at: 't2', loop: 'final', label: 'Принять без финального ревью → отчёт приёмки', reason: 'проверю руками', findings: [] },
    ],
  });
  assert.match(md, /## Пройдено решением человека\n\n- t2 · final: Принять без финального ревью → отчёт приёмки — причина: проверю руками\n\n/);
  assert.match(md, /## Пройдено автопилотом по лимиту раундов\n\nПоследняя правка автора принята без повторного ревью; находки ниже не проверены ревьюером\.\n\n- t1 · artifact:specs: принять «specs» как есть → «design» — причина: автопилот: раунды ревью исчерпаны \(limits\.artifactRounds = 1\)/);
  assert.match(md, /сняты находки: SR-3/);
  assert.match(md, /петли спеки проходят по лимиту раундов policy/);
  assert.match(md, /- waiver: 0 · переходов дальше: 1 · пройдено по лимиту раундов: 1/);
  assert.ok(!reportOf({}).includes('Пройдено автопилотом'), 'без проходов автопилота раздела нет');
});

test('отчёт приёмки: ответы автопилота без раунда правки названы отдельно', () => {
  const md = reportOf({
    spec: {
      questions: [
        { id: 'Q-1', question: 'Что вернуть для пустой строки?', artifact: 'specs', from: 'spec-author', answer: 'Пустую строку', unapplied: true },
        { id: 'Q-2', question: 'Разделитель?', artifact: 'specs', from: 'spec-author', answer: 'дефис' },
      ],
    } as unknown as RunState['spec'],
  });
  assert.match(md, /## Ответы автопилота, не внесённые в спеку\n\nРаундов правки не осталось: ответ записан, артефакт по нему не менялся\.\n\n- Q-1 · specs: Что вернуть для пустой строки\? → Пустую строку\n\n/);
  assert.ok(!md.includes('Q-2'), 'внесённый ответ в раздел не попадает');
});
