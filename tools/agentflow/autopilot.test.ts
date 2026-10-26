// Unit-тесты режима --auto-until-review: включён ли автопилот, выбор вместо waiver, флаги,
// автопилот режима в диалогах и отметка в логе.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autopilotOn, checkModeFlags, untilReviewPick } from './autopilot.ts';
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
