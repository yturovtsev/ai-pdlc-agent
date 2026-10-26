// Unit-тесты диалогов с остановкой: хвост меню, переход дальше и его петля, недоступный пункт.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askHuman, blocker, PassLoop, PROCEED, Scopes, STOP, type PassScope } from './dialogs.ts';
import { Blocked } from './util.ts';
import { Human, type Choice, type DecisionDiscuss, type PromptIO } from './human.ts';
import type { DiscussTurn, RunState } from './state.ts';
import { writeAcceptanceReport } from './report.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Menu = Parameters<PromptIO['select']>[0];
/** Сценарий ввода человека: ответы меню по очереди (ключ или функция от меню) и строки ввода. */
function scripted(selects: (string | ((m: Menu) => string))[], inputs: string[] = []) {
  const menus: Menu[] = [];
  const io: PromptIO = {
    select: async (m) => {
      menus.push(m);
      const s = selects.shift();
      if (s === undefined) throw new Error(`нет ответа для меню «${m.message}»`);
      return typeof s === 'function' ? s(m) : s;
    },
    input: async () => inputs.shift() ?? '',
    checkbox: async () => [],
    tty: () => true,
  };
  return { io, menus };
}
const keys = (m: Menu) => m.choices.map((ch) => ch.value);

const exhausted: Choice<'more' | 'hint' | 'stop'> = {
  title: 'batch 2: 3 автоматических раунда без PASS',
  options: [
    { key: 'more', label: 'Ещё раунд' },
    { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)', description: 'своё описание' },
    { key: 'hint', label: 'Дать указание' },
  ],
  recommended: 'more',
  rationale: 'находки меняются',
};
const batch2: PassScope = { loop: 'batch:2', label: 'считать батч 2 выполненным → батч 3' };

test('недоступный вариант: передаётся в меню, рекомендовать его нельзя', async () => {
  const s = scripted([(m) => m.default!]);
  const ch: Choice = { title: 't', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', disabled: 'нельзя' }], recommended: 'a', rationale: 'r' };
  assert.equal(await new Human(false, s.io).select(ch), 'a');
  assert.equal(s.menus[0]!.choices.find((x) => x.value === 'b')!.disabled, 'нельзя');
  await assert.rejects(new Human(false, s.io).select({ ...ch, recommended: 'b' }), /недоступный/);
});

test('диалог с остановкой: «Остановить run» предпоследним, переход дальше последним', async () => {
  const scopes = new Scopes();
  const s = scripted([STOP]);
  const k = await scopes.passable(batch2, () => askHuman(new Human(false, s.io), exhausted, { scopes }), () => 'passed');
  assert.equal(k, STOP);
  assert.deepEqual(keys(s.menus[0]!), ['more', 'hint', STOP, PROCEED]);
  const last = s.menus[0]!.choices.at(-1)!;
  assert.match(last.name, /Всё равно перейти дальше: считать батч 2 выполненным → батч 3/);
  assert.equal(s.menus[0]!.choices.at(-2)!.description, 'своё описание');
  // Вне петли перехода дальше нет.
  const t = scripted(['more']);
  await askHuman(new Human(false, t.io), exhausted, { scopes });
  assert.deepEqual(keys(t.menus[0]!), ['more', 'hint', STOP]);
});

test('переход дальше: причина (Enter — по умолчанию), петля закрывается своей областью', async () => {
  const scopes = new Scopes();
  const s = scripted([PROCEED, PROCEED], ['  ', 'проверю руками']);
  const human = new Human(false, s.io);
  const a = await scopes.passable(batch2, () => askHuman(human, exhausted, { scopes, defaultReason: 'по умолчанию' }), (r) => `passed: ${r}`);
  assert.equal(a, 'passed: по умолчанию');
  // Вложенная область: PassLoop внутренней не трогает внешнюю.
  const outer: PassScope = { loop: 'final', label: 'Принять без финального ревью → отчёт приёмки' };
  const inner: PassScope = { loop: 'reply', label: 'вернуться к меню без ответа роли' };
  const b = await scopes.passable(
    outer,
    async () => `inner: ${await scopes.passable(inner, () => askHuman(human, exhausted, { scopes }), (r) => r)}`,
    () => 'outer',
  );
  assert.equal(b, 'inner: проверю руками');
  assert.equal(scopes.top(), undefined);
});

test('переход дальше: недоступный пункт, рекомендовать нельзя, PassLoop без петли не ловится', async () => {
  const scopes = new Scopes();
  const s = scripted([(m) => m.default!]);
  const spec: PassScope = { loop: 'artifact:specs', label: 'принять «specs» как есть → «design»', check: () => 'без openspec validate --strict не пройдут freeze и archive' };
  await scopes.passable(spec, () => askHuman(new Human(false, s.io), exhausted, { scopes }), () => 'x');
  assert.match(String(s.menus[0]!.choices.at(-1)!.disabled), /validate --strict/);
  await assert.rejects(askHuman(new Human(false, s.io), { ...exhausted, recommended: PROCEED as never }, { scopes }), /не может быть рекомендован/);
  await assert.rejects(
    scopes.passable(batch2, async () => {
      throw new PassLoop(spec, 'чужая');
    }, () => 'x'),
    PassLoop,
  );
});

test('автопилот: переход дальше только по точке proceed:<петля>, один раз и если пункт доступен', async () => {
  const scopes = new Scopes();
  const taken: string[] = [];
  const inject = (p: string) => (taken.includes(p) ? false : (taken.push(p), true));
  const human = new Human(true);
  const once = () => scopes.passable(batch2, () => askHuman(human, exhausted, { scopes, inject }), (r) => `passed: ${r}`);
  assert.equal(await once(), 'passed: fault injection');
  assert.equal(await once(), 'more');
  assert.equal(await scopes.passable(batch2, () => askHuman(human, exhausted, { scopes }), () => 'x'), 'more');
  const blocked: PassScope = { ...batch2, loop: 'artifact:specs', check: () => 'нельзя' };
  assert.equal(await scopes.passable(blocked, () => askHuman(human, exhausted, { scopes, inject }), () => 'x'), 'more');
  assert.ok(!taken.includes('proceed:artifact:specs'), 'недоступный пункт точку не тратит');
});

function decisionStub(replies: ({ answer: string } | { error: string })[], over: Partial<DecisionDiscuss> = {}) {
  const calls: { role: string; message: string; history: DiscussTurn[] }[] = [];
  const saved: DiscussTurn[] = [];
  const d: DecisionDiscuss = {
    roles: ['code-reviewer', 'implementer'],
    history: [],
    limit: 5,
    reply: async (role, message, history) => {
      calls.push({ role, message, history: [...history] });
      return replies.shift() ?? { answer: 'ok' };
    },
    onTurn: (t) => saved.push(t),
    ...over,
  };
  return { d, calls, saved };
}

test('обсуждение решения: пункты ролей перед хвостом, ответ и снова то же меню', async () => {
  const scopes = new Scopes();
  const s = scripted(['discuss:code-reviewer', 'discuss:implementer', 'more'], ['насколько критична находка?', 'почему не сходится?']);
  const st = decisionStub([{ answer: 'A1' }, { answer: 'A2' }]);
  const k = await scopes.passable(batch2, () => askHuman(new Human(false, s.io), { ...exhausted, discuss: st.d }, { scopes }), () => 'x');
  assert.equal(k, 'more');
  assert.deepEqual(keys(s.menus[0]!), ['more', 'hint', 'discuss:code-reviewer', 'discuss:implementer', STOP, PROCEED]);
  assert.deepEqual(keys(s.menus[2]!), keys(s.menus[0]!));
  assert.deepEqual(st.calls.map((c) => [c.role, c.message, c.history.length]), [['code-reviewer', 'насколько критична находка?', 0], ['implementer', 'почему не сходится?', 1]]);
  assert.deepEqual(st.saved.map((t) => [t.role, t.answer]), [['code-reviewer', 'A1'], ['implementer', 'A2']]);
  assert.equal(st.d.history.length, 2);
});

test('обсуждение решения: пустая реплика и сбой роли переписку не меняют', async () => {
  const s = scripted(['discuss:code-reviewer', 'discuss:code-reviewer', 'more'], ['   ', 'M']);
  const st = decisionStub([{ error: 'CLI exited with code 1' }]);
  await new Human(false, s.io).select({ ...exhausted, discuss: st.d });
  assert.deepEqual(st.calls.map((c) => c.message), ['M']);
  assert.deepEqual(st.d.history, []);
  assert.equal(st.saved.length, 0);
  assert.equal(s.menus.length, 3);
});

test('обсуждение решения: лимит реплик, автопилот и реплика fault injection', async () => {
  const hist = (n: number) => Array.from({ length: n }, (_, i) => ({ at: 'x', message: `m${i}`, answer: `a${i}`, role: 'implementer' }));
  const s = scripted(['discuss:implementer', (m) => m.default!, 'more']);
  await new Human(false, s.io).select({ ...exhausted, discuss: decisionStub([], { history: hist(5) }).d });
  assert.equal(s.menus[1]!.default, 'choose');
  assert.match(s.menus[1]!.message, /5 реплик/);
  const st = decisionStub([{ answer: 'mock' }], { autoMessage: 'Какие находки критичны?' });
  assert.equal(await new Human(true).select({ ...exhausted, discuss: st.d }), 'more');
  assert.deepEqual(st.calls.map((c) => [c.role, c.message]), [['code-reviewer', 'Какие находки критичны?']]);
});

test('отчёт приёмки: раздел «Пройдено решением человека», число реплик у решения', () => {
  const state = (over: Partial<RunState> = {}) =>
    ({
      runId: 'r',
      change: 'add-slugify',
      status: 'running',
      branch: 'agentflow/add-slugify',
      worktree: '/wt',
      baseCommit: 'abcdef1234',
      spec: { freeze: { digest: 'd'.repeat(64) } },
      loops: [],
      gates: [],
      findings: [],
      models: {},
      usage: {},
      decisions: [],
      proceeded: [],
      dialogs: {},
      ...over,
    }) as unknown as RunState;
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-report-'));
  const md = readFileSync(
    writeAcceptanceReport(
      dir,
      state({
        final: { status: 'PASSED_BY_HUMAN', snapshot: 's', rounds: 2, traceability: [] },
        proceeded: [{ at: 't', loop: 'final', label: 'Принять без финального ревью → отчёт приёмки', reason: 'проверю руками', findings: ['CR-1', 'CR-2'] }],
        decisions: [{ at: 't', gate: 'exhausted:финальное ревью', decision: 'more', comment: 'обсуждение: 2 реплики' }],
      }),
      '',
    ),
    'utf8',
  );
  assert.match(md, /## Пройдено решением человека\n\n- t · final: Принять без финального ревью → отчёт приёмки — причина: проверю руками · сняты находки: CR-1, CR-2/);
  assert.match(md, /финальное ревью пройдено решением человека — трассировки нет/);
  assert.match(md, /exhausted:финальное ревью: more — обсуждение: 2 реплики/);
  const plain = readFileSync(writeAcceptanceReport(dir, state(), ''), 'utf8');
  assert.match(plain, /## Пройдено решением человека\n\n\(нет\)/);
  assert.match(plain, /\(финальное ревью не пройдено\)/);
});

test('диалог блокера: пункты и рекомендация, автопилот останавливает run с причиной вердикта', async () => {
  const scopes = new Scopes();
  const final: PassScope = { loop: 'final', label: 'Принять без финального ревью → отчёт приёмки' };
  const s = scripted([(m) => m.default!, 'context']);
  const human = new Human(false, s.io);
  const b = { title: 'финальное ревью: BLOCKED', reason: 'не хватает контекста: формат даты' };
  await assert.rejects(scopes.passable(final, () => blocker(human, b, { scopes }), () => 'x' as const), (e: Error) => e instanceof Blocked && e.message === b.reason);
  assert.deepEqual(keys(s.menus[0]!), [STOP, 'context', PROCEED]);
  assert.equal(s.menus[0]!.default, STOP);
  assert.equal(await scopes.passable(final, () => blocker(human, { ...b, retry: 'Решить спор указанием и продолжить' }, { scopes }), () => 'x' as const), 'context');
  assert.match(s.menus[1]!.choices.find((x) => x.value === 'context')!.name, /Решить спор указанием/);
  await assert.rejects(blocker(new Human(true), b, { scopes }), Blocked);
});
