// Офлайн-тесты детерминированных узлов: контракт ревью, правила принятия, ACL, tasks, glob, выбор схемы OpenSpec, панель статуса,
// экран лога и режим мыши.
//   npm run test:agentflow
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchesFromTasks, discussPrompt, formatDiscussion, parseDiscussReply, parseTasks } from './context-builder.ts';
import { deepMerge, KIT } from './config.ts';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { OpenSpec } from './openspec.ts';
import { decide, validateReview, type Expectation } from './review-validator.ts';
import { aclDenyMessage, apiErrorIn, decideAcl, loadRoles, runRole, Watchdog, describeTask, mcpViolations, mcpWarnings, sessionTools, type RoleDef, type RoleRuntime } from './roles.ts';
import { loadPolicy, type Policy } from './policy.ts';
import { runMock } from './mock.ts';
import { aclRetryAddendum, diagnose, recommendIntervention, type Intervention, type InterventionDecision } from './intervention.ts';
import { Human, replies, type Discuss, type PromptIO, type QuestionView } from './human.ts';
import type { DiscussReply } from './context-builder.ts';
import type { DiscussTurn } from './state.ts';
import { normalize } from './snapshot.ts';
import { globToRegExp } from './util.ts';
import { c, log, moreLines, thinkingLines } from './log.ts';
import { InputParser, mouse, mouseEnabled, WHEEL_PAUSE_MS } from './mouse.ts';
import { charWidth, CursorModel, screen, textWidth, wrapText } from './screen.ts';
import { SessionTracker, WAITING_MODEL } from './session-tracker.ts';
import { fit, panel, panelEnabled, renderPanel, stepLevel, stripAnsi, type PanelState } from './status-panel.ts';

const exp: Expectation = { role: 'spec-reviewer', target: 'design', snapshotId: 'sha256:abc', round: 2, mandatoryChecks: ['DESIGN-ERRORS'] };
const review = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    status: 'REVISE',
    role: 'spec-reviewer',
    target: 'design',
    snapshotId: 'sha256:abc',
    round: 2,
    checks: [{ id: 'DESIGN-ERRORS', result: 'FAIL' }],
    findings: [{ id: 'F-001', severity: 'major', location: 'design.md:72', problem: 'нет ответа на повтор', evidence: 'specs/api/spec.md:40' }],
    ...over,
  });

test('валидный ответ в fenced-блоке принимается и даёт REVISE', () => {
  const v = validateReview('Вот ответ:\n```json\n' + review() + '\n```', exp);
  assert.ok(v.ok);
  assert.equal(decide(v.review, 'spec').verdict, 'REVISE');
});

test('битый JSON — ошибка шага, а не вердикт', () => {
  assert.equal(validateReview('{"status":"PASS", обрыв', exp).ok, false);
});

test('PASS при major — невалидный ответ', () => {
  assert.equal(validateReview(review({ status: 'PASS' }), exp).ok, false);
});

test('чужой snapshotId — вердикт к другой редакции', () => {
  assert.equal(validateReview(review({ snapshotId: 'sha256:old' }), exp).ok, false);
});

test('нет обязательного check — ошибка контракта', () => {
  assert.equal(validateReview(review({ checks: [] }), exp).ok, false);
});

test('NOT_VERIFIED по обязательному check превращает ответ в BLOCKED', () => {
  const v = validateReview(review({ status: 'PASS', findings: [], checks: [{ id: 'DESIGN-ERRORS', result: 'NOT_VERIFIED' }] }), exp);
  assert.ok(v.ok);
  assert.equal(v.review.status, 'BLOCKED');
});

test('находка без evidence отбрасывается, REVISE без блокирующих понижается до PASS', () => {
  const v = validateReview(review({ findings: [{ id: 'F-1', severity: 'major', location: 'x:1', problem: 'p', evidence: '' }] }), exp);
  assert.ok(v.ok);
  assert.equal(v.dropped.length, 1);
  assert.equal(decide(v.review, 'spec').verdict, 'PASS');
});

test('minor и nit не запускают цикл исправлений', () => {
  const v = validateReview(review({ findings: [{ id: 'F-2', severity: 'minor', location: 'x:1', problem: 'p', evidence: 'e' }] }), exp);
  assert.ok(v.ok);
  assert.equal(decide(v.review, 'spec').verdict, 'PASS');
});

test('needsHuman: в фазе спеки копится, в apply — BLOCKED', () => {
  const f = { id: 'F-3', severity: 'major', location: 'x:1', problem: 'развилка', evidence: 'e', needsHuman: true };
  const v = validateReview(review({ findings: [f] }), exp);
  assert.ok(v.ok);
  assert.equal(decide(v.review, 'spec').verdict, 'PASS');
  assert.equal(decide(v.review, 'spec').human.length, 1);
  assert.equal(decide(v.review, 'apply').verdict, 'BLOCKED');
});

test('финальное ревью обязано покрыть все требования в traceability', () => {
  const e = { ...exp, requireTrace: ['REQ-A-1', 'REQ-A-2'] };
  const v = validateReview(review({ traceability: [{ requirementId: 'REQ-A-1', result: 'PASS' }] }), e);
  assert.equal(v.ok, false);
});

const rt = {
  change: 'add-x',
  worktree: '/w',
  contextsDir: '/w/ctx',
  ledger: () => {},
  policy: {
    acceptance: { dir: 'e2e', framework: '' },
    gates: { ops: { lint: 'eslint .', unit: 'node --test', e2e: 'node --test e2e' }, batch: [], full: [] },
    roles: {
      'spec-author': { write: ['openspec/changes/{change}/**'], shell: [] },
      implementer: { write: ['**'], denyWrite: ['openspec/**', '{acceptance}/**'], shell: ['lint', 'unit'] },
      'code-reviewer': { write: [], shell: [] },
    },
  },
} as unknown as RoleRuntime;

test('ACL: spec-author пишет только в свой change', () => {
  assert.ok(decideAcl(rt, 'spec-author', false, 'write_file', { file_path: '/w/openspec/changes/add-x/proposal.md' }).ok);
  assert.equal(decideAcl(rt, 'spec-author', false, 'write_file', { file_path: 'src/a.js' }).ok, false);
});

test('ACL: implementer не пишет в спеку и e2e, вне worktree и через git', () => {
  assert.ok(decideAcl(rt, 'implementer', false, 'edit', { file_path: 'src/a.js' }).ok);
  assert.equal(decideAcl(rt, 'implementer', false, 'edit', { file_path: 'openspec/changes/add-x/tasks.md' }).ok, false);
  assert.equal(decideAcl(rt, 'implementer', false, 'write_file', { file_path: '/etc/passwd' }).ok, false);
  assert.equal(decideAcl(rt, 'implementer', false, 'edit', { file_path: 'e2e/a.test.js' }).ok, false);
  assert.ok(decideAcl(rt, 'implementer', false, 'run_shell_command', { command: 'agentflow-gate lint' }).ok);
  assert.equal(decideAcl(rt, 'implementer', false, 'run_shell_command', { command: 'agentflow-gate e2e' }).ok, false);
  assert.equal(decideAcl(rt, 'implementer', false, 'run_shell_command', { command: 'agentflow-gate lint && git push' }).ok, false);
  assert.equal(decideAcl(rt, 'implementer', false, 'run_shell_command', { command: 'npm run lint' }).ok, false);
});

test('ACL: ревьюер не пишет, шаг readOnly не пишет никому', () => {
  assert.equal(decideAcl(rt, 'code-reviewer', false, 'write_file', { file_path: 'src/a.js' }).ok, false);
  assert.equal(decideAcl(rt, 'implementer', true, 'write_file', { file_path: 'src/a.js' }).ok, false);
});

test('ACL: категория, подсказка и разрешённое у каждого вида отказа', () => {
  const cases: [string, boolean, string, Record<string, unknown>, string, string[]][] = [
    ['spec-author', true, 'write_file', { file_path: 'openspec/changes/add-x/proposal.md' }, 'expected', ['действий не нужно']],
    ['implementer', false, 'write_file', { file_path: '/etc/passwd' }, 'expected', ['действий не нужно']],
    ['implementer', false, 'write_file', {}, 'expected', ['действий не нужно']],
    ['spec-author', false, 'write_file', { file_path: 'docs/notes.md' }, 'permission', ['roles.spec-author.write', 'docs/notes.md']],
    ['implementer', false, 'write_file', { file_path: 'openspec/specs/x/spec.md' }, 'expected', ['openspec/**', 'roles.implementer.denyWrite']],
    ['implementer', false, 'run_shell_command', { command: 'npm test' }, 'expected', ['gates.ops', 'roles.implementer.shell']],
    ['implementer', false, 'run_shell_command', { command: 'agentflow-gate e2e' }, 'permission', ['roles.implementer.shell', 'e2e']],
    ['implementer', false, 'run_shell_command', { command: 'agentflow-gate deploy' }, 'expected', ['agentflow-gate lint']],
    ['spec-author', false, 'mcp__jira__get_issue', {}, 'permission', ['roles.spec-author.mcp', 'mcp__jira__get_issue']],
    ['implementer', false, 'ask_user_question', {}, 'expected', ['шаг уточнений', 'действий не нужно']],
  ];
  for (const [role, readOnly, tool, input, category, parts] of cases) {
    const d = decideAcl(rt, role, readOnly, tool, input);
    const label = `${role} ${tool} ${JSON.stringify(input)}`;
    assert.equal(d.ok, false, label);
    assert.equal(d.category, category, label);
    assert.ok(d.allowed, label);
    for (const p of parts) assert.ok(d.hint!.includes(p), `${label}: ${d.hint} ∌ ${p}`);
  }
  const shell = decideAcl(rt, 'implementer', false, 'run_shell_command', { command: 'npm test' });
  assert.ok(shell.allowed!.includes('agentflow-gate lint') && shell.allowed!.includes('agentflow-gate unit'), shell.allowed);
  const ok = decideAcl(rt, 'implementer', false, 'run_shell_command', { command: 'agentflow-gate lint' });
  assert.equal(ok.category, undefined);
});

test('ACL: модель получает причину, разрешённое и просьбу не повторять', () => {
  const msg = aclDenyMessage(decideAcl(rt, 'implementer', false, 'run_shell_command', { command: 'npm test' }));
  for (const part of ['agentflow ACL:', 'agentflow-gate lint', 'agentflow-gate unit', 'Не повторяй']) assert.ok(msg.includes(part), msg);
});

const mcpPolicy = (mcp?: string[]) =>
  ({ ...rt.policy, denyAll: ['Bash(git *)'], roles: { ...rt.policy.roles, 'spec-author': { write: [], shell: [], ...(mcp ? { mcp } : {}) } } }) as unknown as Policy;
const mcpRt = (mcp?: string[]) => ({ ...rt, policy: mcpPolicy(mcp) }) as RoleRuntime;
const roleDef = (name: string, tools: string[]) => ({ name, tools, file: `kit:.qwen/agents/${name}.md` }) as unknown as RoleDef;

test('ACL MCP: разрешено только по шаблону roles.<роль>.mcp и не в шаге readOnly', () => {
  const ok = decideAcl(mcpRt(['mcp__jira__*']), 'spec-author', false, 'mcp__jira__get_issue', {});
  assert.ok(ok.ok);
  assert.match(ok.reason, /mcp__jira__\*/);
  const out = decideAcl(mcpRt(['mcp__jira__get_issue']), 'spec-author', false, 'mcp__jira__create_issue', {});
  assert.equal(out.ok, false);
  assert.match(out.reason, /roles\.spec-author\.mcp/);
  assert.equal(decideAcl(mcpRt(['mcp__jira__*']), 'spec-author', true, 'mcp__jira__get_issue', {}).ok, false);
  assert.equal(decideAcl(mcpRt(['mcp__jira__*']), 'code-reviewer', false, 'mcp__jira__get_issue', {}).ok, false);
});

test('сессия: без mcp и в шаге readOnly MCP-инструменты не регистрируются', () => {
  const r = roleDef('spec-author', ['read_file', 'mcp__jira__get_issue']);
  const none = sessionTools(mcpPolicy(), r);
  assert.deepEqual(none.coreTools, ['read_file']);
  assert.deepEqual(none.excludeTools, ['Bash(git *)', 'mcp__*']);
  assert.equal(none.allowedMcpServerNames, undefined);
  assert.ok(sessionTools(mcpPolicy(['mcp__jira__*']), r, true).excludeTools.includes('mcp__*'));
});

test('сессия: подключаются только серверы из шаблонов, шаблон без сервера — все', () => {
  const r = roleDef('spec-author', ['read_file']);
  const named = sessionTools(mcpPolicy(['mcp__jira__*', 'mcp__jira__get_issue']), r);
  assert.deepEqual(named.allowedMcpServerNames, ['jira']);
  assert.equal(named.excludeTools.includes('mcp__*'), false);
  assert.equal(sessionTools(mcpPolicy(['mcp__*']), r).allowedMcpServerNames, undefined);
  assert.equal(sessionTools(mcpPolicy(['mcp__ji*__x', 'mcp__jira__*']), r).allowedMcpServerNames, undefined);
});

test('сверка MCP-вызовов после роли', () => {
  const p = mcpPolicy(['mcp__jira__get_issue']);
  assert.deepEqual(mcpViolations(p, 'spec-author', false, ['mcp__jira__get_issue', 'mcp__jira__search', 'mcp__jira__search']), ['mcp__jira__search']);
  assert.deepEqual(mcpViolations(p, 'spec-author', false, ['mcp__jira__get_issue']), []);
  assert.deepEqual(mcpViolations(p, 'spec-author', true, ['mcp__jira__get_issue']), ['mcp__jira__get_issue']);
  assert.deepEqual(mcpViolations(p, 'code-reviewer', false, ['mcp__jira__get_issue']), ['mcp__jira__get_issue']);
});

test('предупреждение: MCP в tools: роли без разрешения в policy', () => {
  const roles = new Map([['spec-author', roleDef('spec-author', ['read_file', 'mcp__jira__get_issue'])]]);
  const [w, ...rest] = mcpWarnings(mcpPolicy(), roles);
  assert.equal(rest.length, 0);
  assert.match(w!, /mcp__jira__get_issue.*roles\.spec-author\.mcp/);
  assert.deepEqual(mcpWarnings(mcpPolicy(['mcp__jira__*']), roles), []);
});

test('ошибка API в тексте ответа — сбой шага, а не ответ роли', () => {
  assert.equal(apiErrorIn('{"status": "PASS"}'), undefined);
  assert.equal(apiErrorIn('[API Error: terminated (Status: 400)]'), '[API Error: terminated (Status: 400)]');
  assert.match(apiErrorIn('Читаю спеку.[API Error: Request timeout after 120s.\n\nTroubleshooting tips:]') ?? '', /^\[API Error: Request timeout/);
});

test('tasks.md: группа ## N. — task batch', () => {
  const b = parseTasks('# Tasks\n\n## 1. Ядро\n\n- [ ] 1.1 Сделать a\n- [x] 1.2 Сделать b\n\n## 2. Экспорт\n- [ ] 2.1 Экспорт\n');
  assert.deepEqual(b.map((x) => [x.id, x.tasks.length]), [['1', 2], ['2', 1]]);
});

test('digest нормализует галочки задач', () => {
  assert.equal(normalize('- [x] 1.1 a\r\n'), normalize('- [ ] 1.1 a'));
});

test('glob', () => {
  assert.ok(globToRegExp('openspec/changes/a/**').test('openspec/changes/a/specs/x/spec.md'));
  assert.ok(globToRegExp('specs/**/*.md').test('specs/x/spec.md'));
  assert.equal(globToRegExp('e2e/**').test('src/e2e.js'), false);
});

test('батчи из задач OpenSpec: по заголовкам, выполненные задачи сохраняют done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-'));
  const file = join(dir, 'tasks.md');
  writeFileSync(file, '# Tasks\n\n## 1. Ядро\n\n- [ ] 1.1 Сделать a\n- [x] 1.2 Сделать b\n\n## Экспорт\n- [ ] Экспорт без номера\n');
  const b = batchesFromTasks([
    { id: '1', description: '1.1 Сделать a', done: false, sourcePath: file, line: 5 },
    { id: '2', description: '1.2 Сделать b', done: true, sourcePath: file, line: 6 },
    { id: '3', description: 'Экспорт без номера', done: false, sourcePath: file, line: 9 },
  ]);
  assert.deepEqual(b.map((x) => [x.id, x.title, x.tasks.map((t) => [t.id, !!t.done])]), [
    ['1', 'Ядро', [['1.1', false], ['1.2', true]]],
    ['2', 'Экспорт', [['2.1', false]]],
  ]);
});

test('policy репозитория сливается с policy kit: объекты — по ключам, списки — заменой', () => {
  const merged = deepMerge({ gates: { ops: { lint: 'a', unit: 'b' }, batch: ['lint', 'unit'] }, x: 1 }, { gates: { ops: { lint: 'npm run lint' }, batch: ['lint'] } });
  assert.deepEqual(merged, { gates: { ops: { lint: 'npm run lint', unit: 'b' }, batch: ['lint'] }, x: 1 });
});

/** Репозиторий без своего openspec: config.yaml со схемой schema и, если project, сама схема в openspec/schemas/. */
function schemaRepo(schema: string, project: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-schema-'));
  mkdirSync(join(dir, 'openspec/changes'), { recursive: true });
  writeFileSync(join(dir, 'openspec/config.yaml'), `schema: ${schema}\n`);
  if (project) {
    const to = join(dir, 'openspec/schemas', schema);
    cpSync(join(KIT, 'node_modules/@fission-ai/openspec/schemas/spec-driven'), to, { recursive: true });
    writeFileSync(join(to, 'schema.yaml'), readFileSync(join(to, 'schema.yaml'), 'utf8').replace(/^name: .*/m, `name: ${schema}`));
  }
  return dir;
}

test('схема проекта из config.yaml: её видит OpenSpec kit', async () => {
  const dir = schemaRepo('corp-edition', true);
  const os = new OpenSpec(dir, dir);
  assert.equal(await os.ensureSchema('x', undefined), 'corp-edition');
  assert.equal(os.bin, join(KIT, 'node_modules/.bin/openspec'));
});

test('схему видит только openspec из PATH — берётся он', { skip: process.platform === 'win32' }, async () => {
  const dir = schemaRepo('corp-builtin', false);
  const bin = mkdtempSync(join(tmpdir(), 'agentflow-bin-'));
  writeFileSync(join(bin, 'openspec'), '#!/bin/sh\necho \'[{"name":"corp-builtin","source":"package"}]\'\n');
  chmodSync(join(bin, 'openspec'), 0o755);
  const path = process.env['PATH'];
  process.env['PATH'] = `${bin}${delimiter}${path ?? ''}`;
  try {
    const os = new OpenSpec(dir, dir);
    assert.equal(await os.ensureSchema('x', undefined), 'corp-builtin');
    assert.equal(os.bin, join(bin, 'openspec'));
  } finally {
    process.env['PATH'] = path;
  }
});

test('схему не видит никто — ошибка до создания change со списком схем каждого CLI', async () => {
  const dir = schemaRepo('nope', false);
  await assert.rejects(new OpenSpec(dir, dir).ensureSchema('x', undefined), /не видит схему «nope»[\s\S]*spec-driven \(package\)/);
});

test('явная схема policy перебивает config.yaml', async () => {
  const dir = schemaRepo('corp-edition', true);
  assert.equal(await new OpenSpec(dir, dir).ensureSchema('x', 'spec-driven'), 'spec-driven');
});

const panelState = (over: Partial<PanelState> = {}): PanelState => ({
  runId: '20261020-1200-demo',
  change: 'demo',
  roles: 5,
  launches: 7,
  phase: 'ФАЗА APPLY',
  activity: 'гейт lint: зелёный',
  startedAt: 0,
  ...over,
});

test('панель: строка субагента, строка контроллера и контекст прогона', () => {
  const agent = { role: 'implementer', target: 'батч 2', model: 'qwen3-coder', effort: 'high', resume: false, startedAt: 1_000, tools: 3 };
  const [top, , bottom] = renderPanel(panelState({ agent, loop: { name: 'batch-1', round: 2, max: 3 } }), 200, 126_000);
  for (const part of ['▶ implementer 02:05 · батч 2', 'qwen3-coder', 'effort high', 'новая сессия', 'инстр. 3', 'запуск 7', 'ролей 5']) assert.ok(top.includes(part), part);
  for (const part of ['⏱ 02:06', 'петля «batch-1» 2/3', 'ФАЗА APPLY', 'change demo', 'run 20261020-1200-demo']) assert.ok(bottom.includes(part), part);
  assert.ok(renderPanel(panelState({ agent: { ...agent, resume: true } }), 200, 2_000)[0].includes('продолжение сессии'));
  const [idle, activity] = renderPanel(panelState(), 200, 3_723_000);
  assert.ok(idle.startsWith('⚙ контроллер') && idle.includes('активных 0'), idle);
  assert.ok(activity.includes('гейт lint: зелёный'), activity);
  assert.ok(renderPanel(panelState(), 200, 3_723_000)[2].includes('⏱ 1:02:03'));
});

test('панель: обрезка по видимой ширине без разрыва ANSI', () => {
  const long = 'а'.repeat(150);
  assert.equal(fit('коротко', 40), 'коротко');
  for (const w of [40, 120]) {
    assert.equal([...fit(long, w)].length, w);
    assert.ok(fit(long, w).endsWith('…'));
    const colored = fit(`\x1b[35m${long}\x1b[0m`, w);
    assert.equal([...stripAnsi(colored)].length, w);
    assert.ok(colored.startsWith('\x1b[35m') && colored.endsWith('…\x1b[0m'));
  }
  const [top, , bottom] = renderPanel(panelState({ phase: long }), 40, 0);
  assert.ok([...stripAnsi(top)].length <= 40 && [...stripAnsi(bottom)].length === 40);
});

test('панель включается только в TTY нормального размера без --no-panel', () => {
  const on = { isTTY: true, rows: 30, cols: 120, env: {} };
  assert.equal(panelEnabled(on), true);
  assert.equal(panelEnabled({ ...on, isTTY: false }), false);
  assert.equal(panelEnabled({ ...on, rows: 9 }), false);
  assert.equal(panelEnabled({ ...on, cols: 39 }), false);
  assert.equal(panelEnabled({ ...on, noPanel: true }), false);
  assert.equal(panelEnabled({ ...on, env: { AGENTFLOW_NO_PANEL: '1' } }), false);
  assert.equal(panelEnabled({ ...on, rows: undefined }), false);
});

class FakeTty extends EventEmitter {
  isTTY = true;
  writes: string[] = [];
  constructor(
    public rows: number,
    public columns: number,
  ) {
    super();
  }
  write(s: string): boolean {
    this.writes.push(s);
    return true;
  }
  get all(): string {
    return this.writes.join('');
  }
  /** Последний кадр панели: текст трёх нижних строк без ANSI. */
  frame(): string[] {
    const at = `\x1b[${this.rows - 2};1H`;
    const w = [...this.writes].reverse().find((x) => x.includes(at));
    if (!w) return [];
    return w
      .slice(w.indexOf(at))
      .split(/\x1b\[\d+;1H\x1b\[2K/)
      .slice(1)
      .map((l) => stripAnsi(l.replace(/\x1b8$/, '')));
  }
}

const startPanel = (out: FakeTty, enabled = true) => panel.start({ runId: 'r1', change: 'demo', roles: 5, launches: 0, enabled }, out);

test('панель: область прокрутки, resize и идемпотентный stop', () => {
  const sigint = process.listenerCount('SIGINT');
  const off = new FakeTty(30, 120);
  startPanel(off, false);
  panel.update({ activity: 'x' });
  assert.equal(off.writes.length, 0);

  const out = new FakeTty(30, 120);
  startPanel(out);
  assert.ok(out.all.includes('\x1b[1;27r'));
  assert.equal(process.listenerCount('SIGINT'), sigint + 1);
  out.rows = 24;
  out.columns = 60;
  out.emit('resize');
  assert.ok(out.all.includes('\x1b[1;21r'));
  const f = out.frame();
  assert.equal(f.length, 3);
  for (const l of f) assert.ok([...l].length <= 60, l);
  panel.stop();
  assert.ok(out.writes.at(-1)!.includes('\x1b[?25h'));
  assert.ok(out.all.lastIndexOf('\x1b[r') > out.all.lastIndexOf('\x1b[1;21r'));
  const n = out.writes.length;
  panel.stop();
  assert.equal(out.writes.length, n);
  assert.equal(process.listenerCount('SIGINT'), sigint);
});

test('панель: маленький терминал после resize выключает панель', () => {
  const out = new FakeTty(30, 120);
  startPanel(out);
  out.rows = 8;
  out.emit('resize');
  const n = out.writes.length;
  panel.update({ activity: 'y' });
  assert.equal(out.writes.length, n);
  assert.ok(out.all.endsWith('\x1b[?25h'));
});

test('панель: хуки лога и пауза на время диалога', () => {
  const out = new FakeTty(30, 120);
  startPanel(out);
  log.phase('ФАЗА APPLY');
  log.loopOpen('batch-1', 2, 3);
  log.spawn('implementer', { model: 'qwen3-coder', effort: 'high', session: 'abcdef0123', resume: false, tools: ['read_file'], target: 'батч 1' });
  log.toolUse('implementer', 'read_file', 'src/index.js');
  let [top, middle, bottom] = out.frame();
  assert.ok(top!.includes('▶ implementer') && top!.includes('батч 1') && top!.includes('запуск 1') && top!.includes('инстр. 1') && top!.includes('активных 1'), top);
  assert.ok(bottom!.includes('петля «batch-1» 2/3'), bottom);
  log.roleDone('implementer', { turns: 1, seconds: 0, models: [], denials: 0 });
  log.roleEnd('implementer', true);
  [top] = out.frame();
  assert.ok(top!.startsWith('⚙ контроллер') && top!.includes('активных 0'), top);
  log.gateStart('unit');
  [, middle] = out.frame();
  assert.ok(middle!.includes('гейт unit выполняется') && /с \d\d:\d\d:\d\d/.test(middle!), middle);
  log.gate('lint', true, '');
  [, middle] = out.frame();
  assert.ok(middle!.includes('гейт lint'), middle);

  panel.pause();
  assert.ok(out.writes.at(-1)!.includes('\x1b[r'));
  const n = out.writes.length;
  log.step('во время диалога');
  assert.equal(out.writes.length, n);
  panel.resume();
  assert.ok(out.writes.slice(n).join('').includes('\x1b[1;27r'));
  log.loopClose('PASS');
  panel.stop();
});

test('цель вызова роли для панели: по виду шага', () => {
  assert.equal(describeTask({ kind: 'clarify' }), 'уточнение intent');
  assert.equal(describeTask({ kind: 'discuss', discuss: { id: 'Q-2', options: [], recommended: 0 } }), 'обсуждение вопроса Q-2');
  assert.equal(describeTask({ kind: 'author', artifact: 'design', generates: 'design.md' }), 'пишет design.md');
  assert.equal(describeTask({ kind: 'author', artifact: 'specs', generates: 'specs/**/*.md' }), 'пишет specs/**/*.md');
  assert.equal(describeTask({ kind: 'spec-review', artifact: 'design', target: 'design' }), 'ревью design');
  assert.equal(describeTask({ kind: 'holistic', target: 'change' }), 'сквозное ревью change');
  assert.equal(describeTask({ kind: 'implement', batchId: '2' }), 'батч 2');
  assert.equal(describeTask({ kind: 'implement', batchId: 'final-1' }), 'исправления финального ревью, раунд 1');
  assert.equal(describeTask({ kind: 'code-review', batchId: '2', target: 'batch-2' }), 'ревью батча 2');
  assert.equal(describeTask({ kind: 'acceptance', target: 'acceptance' }), 'acceptance-тесты');
  assert.equal(describeTask({ kind: 'final-review', target: 'final' }), 'финальное ревью');
});

const clock = (t0 = 0) => {
  const c = { t: t0, now: () => c.t };
  return c;
};
const MIN = 60_000;
const tracker = (c: { now: () => number }, over: { stallMs?: number; denialStreak?: number } = {}) =>
  new SessionTracker({ role: 'implementer', stallMs: 15 * MIN, denialStreak: 5, now: c.now, ...over });
const denyShell = (cmd: string) => decideAcl(rt, 'implementer', false, 'run_shell_command', { command: cmd });

test('трекер: шаг — незавершённый вызов, после результата — ожидание модели с момента результата', () => {
  const c = clock(1_000);
  const t = tracker(c);
  assert.deepEqual(t.step(), { label: WAITING_MODEL, since: 1_000 });
  c.t = 2_000;
  t.event();
  t.toolUse('1', 'run_shell_command', 'agentflow-gate unit');
  c.t = 3_000;
  t.event();
  t.toolUse('2', 'read_file', 'src/a.js');
  assert.deepEqual(t.step(), { label: '→ run_shell_command agentflow-gate unit', since: 2_000 });
  c.t = 4_000;
  t.event();
  t.toolResult('1', false);
  assert.deepEqual(t.step(), { label: '→ read_file src/a.js', since: 3_000 });
  c.t = 5_000;
  t.event();
  t.toolResult('2', false);
  assert.deepEqual(t.step(), { label: WAITING_MODEL, since: 5_000 });
});

test('трекер: вложенный субагент считается до своего результата', () => {
  const c = clock();
  const t = tracker(c);
  t.toolUse('7', 'task', '');
  assert.equal(t.nested, 1);
  c.t = 1_000;
  t.event();
  t.toolUse('n1', 'read_file', 'src/b.js', '7');
  assert.deepEqual(t.step(), { label: 'вложенный субагент: → read_file src/b.js', since: 1_000 });
  t.toolResult('n1', false, '7');
  assert.equal(t.nested, 1);
  t.toolResult('7', false);
  assert.equal(t.nested, 0);
  assert.equal(t.step().label, WAITING_MODEL);
});

test('трекер: простой по порогу, активность сбрасывает отсчёт, 0 выключает сторожа', () => {
  const c = clock();
  const t = tracker(c);
  c.t = 14 * MIN;
  assert.equal(t.stalled(), false);
  t.event();
  c.t = 28 * MIN;
  assert.equal(t.stalled(), false);
  c.t = 29 * MIN;
  assert.equal(t.stalled(), true);
  t.resetIdle();
  assert.equal(t.stalled(), false);
  assert.equal(t.idleMs(), 15 * MIN, 'простой в диагнозе — от последнего события, а не от «ждать»');
  const off = tracker(c, { stallMs: 0 });
  c.t += 60 * MIN;
  assert.equal(off.stalled(), false);
});

test('трекер: серия отказов, сброс разрешённым вызовом и успешным результатом', () => {
  const t = tracker(clock());
  for (let i = 0; i < 4; i++) t.acl('run_shell_command', { command: 'npm test' }, denyShell('npm test'));
  assert.equal(t.streakHit(), false);
  t.acl('run_shell_command', { command: 'npm test' }, denyShell('npm test'));
  assert.equal(t.streakHit(), true);
  assert.equal(t.streakDenials().length, 5);
  t.resetStreak();
  for (let i = 0; i < 4; i++) t.acl('run_shell_command', { command: 'npm test' }, denyShell('npm test'));
  t.acl('run_shell_command', { command: 'agentflow-gate lint' }, denyShell('agentflow-gate lint'));
  t.acl('run_shell_command', { command: 'npm test' }, denyShell('npm test'));
  assert.equal(t.streak, 1);
  for (let i = 0; i < 3; i++) t.acl('run_shell_command', { command: 'npm test' }, denyShell('npm test'));
  t.toolUse('r', 'read_file', 'a.js');
  t.toolResult('r', false);
  t.acl('run_shell_command', { command: 'npm test' }, denyShell('npm test'));
  assert.equal(t.streak, 1);
  assert.equal(tracker(clock(), { denialStreak: 0 }).streakHit(), false);
});

test('сводка отказов: группы по вызову и причине, отказы CLI отдельно', () => {
  const t = tracker(clock());
  const spec = { file_path: 'openspec/specs/x/spec.md' };
  t.acl('run_shell_command', { command: 'npm test' }, denyShell('npm test'));
  t.acl('run_shell_command', { command: 'npm test' }, denyShell('npm test'));
  t.acl('write_file', spec, decideAcl(rt, 'implementer', false, 'write_file', spec));
  const pd = [
    { tool_name: 'run_shell_command', tool_input: { command: 'npm test' } },
    { tool_name: 'run_shell_command', tool_input: { command: 'npm test' } },
    { tool_name: 'write_file', tool_input: spec },
  ];
  const s = t.summary(pd);
  assert.equal(s.total, 3);
  assert.equal(s.groups.length, 2);
  const shell = s.groups.find((g) => g.tool === 'run_shell_command')!;
  assert.equal(shell.count, 2);
  assert.ok(shell.reason && shell.hint);
  assert.equal(s.groups.find((g) => g.tool === 'write_file')!.count, 1);

  const cli = tracker(clock()).summary([{ tool_name: 'run_shell_command', tool_input: { command: 'git status' } }]);
  assert.equal(cli.total, 1);
  assert.equal(cli.groups[0]!.category, 'cli');
  assert.ok(cli.groups[0]!.hint.includes('denyAll') && cli.groups[0]!.hint.includes('настройки CLI'));
  assert.deepEqual(tracker(clock()).summary([]), { total: 0, groups: [] });
});

test('панель: строка шага с началом и длительностью, подсветка по порогу простоя', () => {
  const since = new Date(2026, 9, 21, 14, 2, 31).getTime();
  const agent = { role: 'implementer', model: 'm', resume: false, startedAt: since, tools: 1, step: { label: '→ run_shell_command agentflow-gate unit', since } };
  const state = panelState({ agent, sessions: 1, stallMs: 15 * MIN });
  const warn = renderPanel(state, 200, since + 9 * MIN)[1];
  for (const part of ['agentflow-gate unit', 'с 14:02:31', '09:00']) assert.ok(stripAnsi(warn).includes(part), warn);
  assert.ok(stripAnsi(renderPanel(state, 200, since + 16 * MIN)[1]).includes('простой 16:00'));
  assert.equal(stepLevel(5 * MIN, 15 * MIN), 'ok');
  assert.equal(stepLevel(9 * MIN, 15 * MIN), 'warn');
  assert.equal(stepLevel(16 * MIN, 15 * MIN), 'stall');
  assert.equal(stepLevel(60 * MIN, 0), 'ok');
  const nested = renderPanel(panelState({ agent: { ...agent, nested: 1 }, sessions: 1 }), 200, since)[0];
  assert.ok(stripAnsi(nested).includes('активных 1 (+1 вложенный)'), nested);
  const denied = renderPanel(panelState({ agent: { ...agent, denials: { count: 1, last: 'разрешена только команда agentflow-gate <операция>' } }, sessions: 1 }), 200, since)[1];
  assert.ok(stripAnsi(denied).includes('ACL 1: разрешена только команда agentflow-gate'), denied);
  const ctl = renderPanel(panelState({ activity: 'гейт unit выполняется', activitySince: since }), 200, since + 41_000)[1];
  assert.ok(ctl.includes('гейт unit выполняется') && ctl.includes('с 14:02:31') && ctl.includes('00:41'), ctl);
});

test('лог: время в строках роли, удержание на время диалога, сводка отказов в итоге роли', () => {
  const printed: string[] = [];
  const orig = console.log;
  console.log = (s: string) => void printed.push(stripAnsi(String(s)));
  try {
    log.toolUse('implementer', 'read_file', 'src/a.js');
    assert.match(printed.at(-1)!, /implementer │ \d\d:\d\d:\d\d → read_file src\/a\.js/);
    log.hold();
    log.role('implementer', 'первая');
    log.role('implementer', 'вторая');
    const n = printed.length;
    log.release();
    assert.equal(printed.length, n + 2);
    assert.ok(printed.at(-2)!.endsWith('первая') && printed.at(-1)!.endsWith('вторая'));
    const groups = [
      { tool: 'run_shell_command', target: 'npm test', reason: 'разрешена только команда agentflow-gate <операция>', count: 2, category: 'expected' as const, hint: 'роль должна вызывать agentflow-gate' },
      { tool: 'write_file', target: 'openspec/specs/x/spec.md', reason: 'защищённый путь', count: 1, category: 'expected' as const, hint: 'путь защищён' },
    ];
    printed.length = 0;
    log.roleDone('implementer', { turns: 3, seconds: 10, models: [], denials: 3, groups });
    assert.ok(printed[0]!.includes('отказов ACL: 3'));
    assert.ok(printed.some((l) => l.includes('2× run_shell_command npm test')) && printed.some((l) => l.includes('1× write_file openspec/specs/x/spec.md')), printed.join('\n'));
    assert.equal(printed.filter((l) => l.includes('что делать:')).length, 2);
  } finally {
    console.log = orig;
  }
});

test('policy: пороги сторожа и серии отказов по умолчанию, в том числе у репозитория без этих ключей', () => {
  const kit = loadPolicy(KIT);
  assert.equal(kit.limits.stallMinutes, 15);
  assert.equal(kit.limits.aclDenialStreak, 5);
  assert.equal(kit.limits.discussTurns, 5);
  const repo = mkdtempSync(join(tmpdir(), 'agentflow-policy-'));
  mkdirSync(join(repo, '.agentflow'));
  writeFileSync(join(repo, '.agentflow/policy.yaml'), 'limits:\n  batchRounds: 4\n');
  const own = loadPolicy(repo);
  assert.equal(own.limits.batchRounds, 4);
  assert.equal(own.limits.stallMinutes, 15);
  assert.equal(own.limits.aclDenialStreak, 5);
  assert.equal(own.limits.discussTurns, 5);
});

const kitRt = (over: Partial<RoleRuntime> = {}): RoleRuntime => {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-rt-'));
  return { policy: loadPolicy(KIT), change: 'x', worktree: dir, contextsDir: dir, ledger: () => {}, ...over };
};

test('сессия, упавшая без ответа CLI, перестаёт считаться в панели', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentflow-cli-'));
  const cli = join(dir, 'fail-cli.sh');
  writeFileSync(cli, '#!/bin/sh\nexit 1\n');
  chmodSync(cli, 0o755);
  const prev = process.env['AGENTFLOW_QWEN_CLI'];
  process.env['AGENTFLOW_QWEN_CLI'] = cli;
  const out = new FakeTty(30, 120);
  startPanel(out);
  try {
    const role = loadRoles(KIT).get('implementer')!;
    const res = await runRole(kitRt(), { role, prompt: 'x', label: 'probe', cwd: dir, meta: { kind: 'implement', batchId: '1' } });
    assert.equal(res.ok, false);
    const [top] = out.frame();
    assert.ok(top!.startsWith('⚙ контроллер') && top!.includes('активных 0'), top);
  } finally {
    panel.stop();
    if (prev === undefined) delete process.env['AGENTFLOW_QWEN_CLI'];
    else process.env['AGENTFLOW_QWEN_CLI'] = prev;
  }
});

test('сторож: молчащая mock-сессия — ждать, затем повтор прерывает её', async () => {
  const decisions: InterventionDecision[] = ['wait', 'retry'];
  const seen: Intervention[] = [];
  const ledger: Record<string, unknown>[] = [];
  const role = loadRoles(KIT).get('implementer')!;
  const res = await runMock(kitRt({ mock: runMock, ledger: (e) => void ledger.push(e) }), {
    role,
    prompt: 'x',
    label: 'probe',
    cwd: '.',
    meta: { kind: 'implement', batchId: '1', silent: true },
    intervene: async (ev) => {
      seen.push(ev);
      return decisions.shift()!;
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.kind, 'stall');
  assert.equal(seen[0]!.step.label, WAITING_MODEL);
  assert.equal(res.ok, false);
  assert.equal(res.intervention?.decision, 'retry');
  assert.match(res.error!, /простой роли/);
  assert.deepEqual(ledger.filter((e) => e['ev'] === 'intervention').map((e) => e['decision']), ['wait', 'retry']);
  assert.equal(ledger.filter((e) => e['ev'] === 'stall').length, 2);
});

test('диалог вмешательства закрывается без выбора, если signal уже прерван', async () => {
  const ctl = new AbortController();
  ctl.abort();
  const k = await new Human(false).selectOrCancel({ title: 't', options: [{ key: 'wait', label: 'Ждать' }], recommended: 'wait', rationale: 'r' }, ctl.signal);
  assert.equal(k, undefined);
  assert.equal(await new Human(true).selectOrCancel({ title: 't', options: [{ key: 'wait', label: 'Ждать' }], recommended: 'wait', rationale: 'r' }, new AbortController().signal), 'wait');
});

const denial = (cmd: string, d = denyShell(cmd)) => ({ tool: 'run_shell_command', arg: cmd, target: d.target, reason: d.reason, category: d.category!, hint: d.hint!, allowed: d.allowed });
const stallEv = (): Intervention => ({ kind: 'stall', role: 'implementer', step: { label: WAITING_MODEL, since: 0 }, idleMs: 15 * MIN, denials: [] });

test('рекомендация вмешательства: простой по номеру, серия ACL по категории отказов', () => {
  assert.equal(recommendIntervention(stallEv(), 1).choice, 'wait');
  assert.equal(recommendIntervention(stallEv(), 2).choice, 'retry');
  assert.equal(recommendIntervention(stallEv(), 3).choice, 'stop');
  assert.equal(recommendIntervention(stallEv(), 7).choice, 'stop');
  const expected: Intervention = { ...stallEv(), kind: 'acl-streak', denials: [denial('npm test'), denial('npm test')] };
  assert.equal(recommendIntervention(expected, 0).choice, 'retry');
  const w = decideAcl(rt, 'implementer', false, 'write_file', { file_path: '../outside.md' });
  const perm = decideAcl(rt, 'spec-author', false, 'write_file', { file_path: 'docs/notes.md' });
  const need: Intervention = { ...expected, denials: [denial('npm test'), { ...denial('x', w) }, { tool: 'write_file', arg: 'docs/notes.md', target: perm.target, reason: perm.reason, category: perm.category!, hint: perm.hint!, allowed: perm.allowed }] };
  const r = recommendIntervention(need, 0);
  assert.equal(r.choice, 'stop');
  assert.ok(r.rationale.includes('roles.spec-author.write'), r.rationale);
});

test('промпт повтора после серии отказов ACL: отклонённые вызовы и разрешённое', () => {
  const text = aclRetryAddendum([denial('npm test'), denial('npm test'), denial('npx eslint .')]);
  for (const part of ['npm test', '×2', 'npx eslint .', 'agentflow-gate lint', 'agentflow-gate unit']) assert.ok(text.includes(part), part);
  assert.ok(diagnose({ ...stallEv(), step: { label: '→ run_shell_command agentflow-gate unit', since: new Date(2026, 9, 21, 14, 2, 31).getTime() } }).includes('agentflow-gate unit с 14:02:31'));
});

test('сторож: диалог серии ACL не закрывается сообщениями сессии, диалог простоя — закрывается', async () => {
  const role = loadRoles(KIT).get('implementer')!;
  const run = async (kind: 'stall' | 'acl-streak') => {
    const c = clock();
    const t = new SessionTracker({ role: 'implementer', stallMs: kind === 'stall' ? 1_000 : 0, denialStreak: 2, now: c.now });
    if (kind === 'stall') c.t = 2_000;
    else for (let i = 0; i < 2; i++) t.acl('run_shell_command', { command: 'npm test' }, denyShell('npm test'));
    let signal: AbortSignal | undefined;
    const abort = new AbortController();
    const call = {
      role,
      prompt: 'x',
      label: 'probe',
      cwd: '.',
      meta: { kind: 'implement' as const },
      intervene: async (_ev: Intervention, s: AbortSignal): Promise<InterventionDecision> => {
        signal = s;
        await new Promise((done) => setTimeout(done, 200));
        return s.aborted ? 'woke' : 'retry';
      },
    };
    const w = new Watchdog(kitRt(), call, t, abort);
    w.check();
    w.activity();
    await new Promise((done) => setTimeout(done, 300));
    const out = { aborted: signal!.aborted, outcome: w.outcome?.decision, session: abort.signal.aborted };
    await w.stop();
    return out;
  };
  assert.deepEqual(await run('acl-streak'), { aborted: false, outcome: 'retry', session: true });
  assert.deepEqual(await run('stall'), { aborted: true, outcome: undefined, session: false });
});

const turn = (message: string, answer: string) => ({ at: '2026-10-24T10:00:00Z', message, answer });
const baseCtx = { change: 'c', changeDir: 'openspec/changes/c', intent: 'intent', clarifications: [] };

test('промпт реплики обсуждения: вопрос, варианты, переписка и новая реплика', () => {
  const p = discussPrompt(baseCtx, {
    id: 'Q-1',
    question: 'Что возвращать?',
    why: 'сценарий пустой строки',
    options: [{ label: 'Пустую строку', description: 'как в intent' }, { label: 'Бросать RangeError' }],
    recommended: 0,
    rationale: 'так в intent',
    files: ['openspec/changes/c/specs/a/spec.md'],
    history: [turn('M1 как это для вызывающего кода?', 'A1 ничего не ломает')],
    message: 'M2 а если строка из пробелов?',
  });
  for (const s of ['Что возвращать?', 'Пустую строку', 'Бросать RangeError', 'M1 как это', 'A1 ничего', 'M2 а если', 'openspec/changes/c/specs/a/spec.md', 'только на чтение']) assert.ok(p.includes(s), s);
});

test('уточнение с перепиской выводится в блоке intent', () => {
  const p = discussPrompt({ ...baseCtx, clarifications: [{ question: 'Кириллица?', answer: 'Отбрасывать', discussion: [turn('чем отличается?', 'таблицей транслитерации')] }] }, {
    id: 'Q-2',
    question: 'q',
    options: [{ label: 'a' }, { label: 'b' }],
    recommended: 0,
    files: [],
    history: [],
    message: 'm',
  });
  assert.match(p, /О: Отбрасывать\n {2}Обсуждение \(1\):\n {2}- Человек: чем отличается\?\n {4}Роль: таблицей транслитерации/);
  assert.ok(formatDiscussion([turn('m', 'x'.repeat(2000))]).includes('x'.repeat(1500) + ' …'));
});

test('разбор ответа реплики обсуждения', () => {
  const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `v${i}` }));
  const js = (o: Record<string, unknown>) => 'текст\n```json\n' + JSON.stringify(o) + '\n```';
  assert.deepEqual(parseDiscussReply(js({ answer: 'A', options: opts(3), recommended: 2, rationale: 'R' })), { answer: 'A', options: opts(3), recommended: 2, rationale: 'R' });
  assert.deepEqual(parseDiscussReply('просто объяснение'), { answer: 'просто объяснение' });
  assert.deepEqual(parseDiscussReply(js({ answer: 'A', options: opts(1) })), { answer: 'A' });
  assert.deepEqual(parseDiscussReply(js({ answer: 'A', options: opts(7) })), { answer: 'A' });
  assert.deepEqual(parseDiscussReply(js({ answer: 'A', options: [{ label: 'a' }, { label: '' }] })), { answer: 'A' });
  assert.equal((parseDiscussReply(js({ answer: 'A', options: opts(3), recommended: 9 })) as { recommended: number }).recommended, 0);
  assert.deepEqual(parseDiscussReply(js({ note: 'x' })), { answer: 'текст' });
  assert.ok('error' in parseDiscussReply('  '));
});

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
    tty: () => true,
  };
  return { io, menus };
}
const keys = (m: Menu) => m.choices.map((ch) => ch.value);
const q2 = { question: 'Что возвращать?', options: [{ label: 'Пустую строку' }, { label: 'Бросать RangeError' }], recommended: 1, rationale: 'r' };
function discussStub(replies: (DiscussReply | { error: string })[], over: Partial<Discuss> = {}) {
  const calls: { message: string; history: DiscussTurn[] }[] = [];
  const turns: { turn: DiscussTurn; q: QuestionView }[] = [];
  const d: Discuss = {
    role: 'spec-author',
    history: [],
    limit: 5,
    reply: async (message, history) => {
      calls.push({ message, history: [...history] });
      return replies.shift() ?? { answer: 'ok' };
    },
    onTurn: (turn, q) => turns.push({ turn, q: structuredClone(q) }),
    ...over,
  };
  return { d, calls, turns };
}

test('вопрос автора: Enter выбирает рекомендацию, «Обсудить» только с discuss', async () => {
  const a = scripted([(m) => m.default!]);
  assert.deepEqual(await new Human(false, a.io).question(q2), { answer: 'Бросать RangeError', discussion: [] });
  assert.deepEqual(keys(a.menus[0]!), ['1', '0', 'own']);
  const b = scripted([(m) => m.default!]);
  await new Human(false, b.io).question(q2, discussStub([]).d);
  assert.deepEqual(keys(b.menus[0]!), ['1', '0', 'own', 'discuss']);
});

test('обсуждение: реплика, ответ роли и снова меню того же вопроса', async () => {
  const s = scripted(['discuss', '0'], ['как это отразится на вызывающем коде?']);
  const st = discussStub([{ answer: 'A1' }]);
  const r = await new Human(false, s.io).question(q2, st.d);
  assert.equal(r.answer, 'Пустую строку');
  assert.deepEqual(r.discussion.map((t) => [t.message, t.answer, t.optionsChanged]), [['как это отразится на вызывающем коде?', 'A1', undefined]]);
  assert.equal(st.calls.length, 1);
  assert.deepEqual(keys(s.menus[1]!), keys(s.menus[0]!));
  assert.equal(st.turns.length, 1);
});

test('обсуждение: вторая реплика получает первую, пустой ввод роль не вызывает', async () => {
  const s = scripted(['discuss', 'discuss', 'discuss', '1'], ['M1', '   ', 'M2']);
  const st = discussStub([{ answer: 'A1' }, { answer: 'A2' }]);
  const r = await new Human(false, s.io).question(q2, st.d);
  assert.deepEqual(st.calls.map((c) => c.message), ['M1', 'M2']);
  assert.deepEqual(st.calls[1]!.history.map((t) => [t.message, t.answer]), [['M1', 'A1']]);
  assert.equal(r.discussion.length, 2);
});

test('обсуждение: роль заменила варианты — новое меню и сохранённый вопрос', async () => {
  const s = scripted(['discuss', (m) => m.default!], ['а третий вариант?']);
  const opts = [{ label: 'a' }, { label: 'b' }, { label: 'c', description: 'новый' }];
  const st = discussStub([{ answer: 'A', options: opts, recommended: 2, rationale: 'R2' }]);
  const r = await new Human(false, s.io).question(q2, st.d);
  assert.equal(r.answer, 'c');
  assert.deepEqual(keys(s.menus[1]!), ['2', '0', '1', 'own', 'discuss']);
  assert.match(s.menus[1]!.choices[0]!.description!, /R2/);
  assert.equal(r.discussion[0]!.optionsChanged, true);
  assert.deepEqual(st.turns[0]!.q.options, opts);
});

test('обсуждение: сбой реплики — причина, меню снова, в переписку не идёт', async () => {
  const s = scripted(['discuss', '0'], ['M1']);
  const st = discussStub([{ error: 'CLI exited with code 1' }]);
  const r = await new Human(false, s.io).question(q2, st.d);
  assert.equal(r.answer, 'Пустую строку');
  assert.deepEqual(r.discussion, []);
  assert.equal(st.turns.length, 0);
  assert.equal(s.menus.length, 2);
});

test('обсуждение: лимит реплик — диалог, продолжение до следующего кратного', async () => {
  const hist = (n: number) => Array.from({ length: n }, (_, i) => ({ at: 'x', message: `m${i}`, answer: `a${i}` }));
  // Пять реплик: «Обсудить» → диалог лимита, рекомендован возврат к выбору.
  const a = scripted(['discuss', (m) => m.default!, '0']);
  await new Human(false, a.io).question(q2, discussStub([], { history: hist(5) }).d);
  assert.equal(a.menus[1]!.default, 'choose');
  assert.match(a.menus[1]!.message, /5 реплик/);
  assert.deepEqual(keys(a.menus[1]!).sort(), ['choose', 'continue']);
  // «Продолжить» → ещё пять реплик без диалога, на десятой — снова диалог.
  const b = scripted(['discuss', 'continue', ...Array(4).fill('discuss'), 'discuss', 'choose', '0'], ['m5', 'm6', 'm7', 'm8', 'm9']);
  const st = discussStub([], { history: hist(5) });
  const r = await new Human(false, b.io).question(q2, st.d);
  assert.equal(r.discussion.length, 10);
  assert.deepEqual(b.menus.map((m) => (keys(m).includes('continue') ? 'limit' : 'q')), ['q', 'limit', 'q', 'q', 'q', 'q', 'q', 'limit', 'q']);
  // limit = 0 — диалога нет.
  const c = scripted(['discuss', '0'], ['m']);
  await new Human(false, c.io).question(q2, discussStub([], { history: hist(7), limit: 0 }).d);
  assert.equal(c.menus.length, 2);
});

test('обсуждение при автопилоте: только реплика inject, ответ — рекомендация', async () => {
  const none = discussStub([]);
  assert.equal((await new Human(true).question(q2, none.d)).answer, 'Бросать RangeError');
  assert.equal(none.calls.length, 0);
  const inj = discussStub([{ answer: 'A' }], { autoMessage: 'Чем варианты отличаются?' });
  const r = await new Human(true).question(q2, inj.d);
  assert.deepEqual([r.answer, inj.calls.length, r.discussion.length], ['Бросать RangeError', 1, 1]);
});

test('склонение реплик', () => {
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25].map(replies), ['1 реплика', '2 реплики', '5 реплик', '11 реплик', '12 реплик', '21 реплика', '22 реплики', '25 реплик']);
});

// ─── Экран лога и режим мыши ───

/**
 * Эмулятор терминала для тестов экрана: сетка, история строк, ушедших за верх области с верхней
 * строкой 1, область прокрутки, сохранённый курсор, отложенный перенос и ответ на запрос позиции.
 */
class Vt {
  grid: string[][];
  history: string[] = [];
  replies: [number, number][] = [];
  r = 0;
  c = 0;
  wraps = 0;
  private top = 0;
  private bottom: number;
  private saved = { r: 0, c: 0 };
  private mode: 'text' | 'esc' | 'csi' | 'osc' = 'text';
  private params = '';
  constructor(
    public rows: number,
    public cols: number,
  ) {
    this.grid = Array.from({ length: rows }, () => this.blank());
    this.bottom = rows - 1;
  }
  private blank(): string[] {
    return Array<string>(this.cols).fill(' ');
  }
  lines(): string[] {
    return this.grid.map((l) => l.join('').trimEnd());
  }
  /** Строка экрана (с 1), где есть text, или 0. */
  row(text: string): number {
    return this.lines().findIndex((l) => l.includes(text)) + 1;
  }
  feed(s: string): void {
    for (const ch of s) {
      if (this.mode === 'esc') this.escape(ch);
      else if (this.mode === 'csi') this.csi(ch);
      else if (this.mode === 'osc') this.mode = ch === '\x07' ? 'text' : 'osc';
      else this.text(ch);
    }
  }
  private text(ch: string): void {
    const cp = ch.codePointAt(0)!;
    if (ch === '\x1b') this.mode = 'esc';
    else if (ch === '\n') {
      this.c = 0;
      this.lf();
    } else if (ch === '\r') this.c = 0;
    else if (cp >= 0x20) {
      const w = charWidth(cp);
      if (!w) return;
      if (this.c + w > this.cols) {
        this.c = 0;
        this.lf();
        this.wraps++;
      }
      this.grid[this.r]![this.c] = ch;
      if (w === 2) this.grid[this.r]![this.c + 1] = '';
      this.c += w;
    }
  }
  private escape(ch: string): void {
    this.mode = ch === '[' ? 'csi' : ch === ']' ? 'osc' : 'text';
    this.params = '';
    if (ch === '7') this.saved = { r: this.r, c: this.c };
    if (ch === '8') ({ r: this.r, c: this.c } = this.saved);
  }
  private csi(ch: string): void {
    if (/[0-9;?]/.test(ch)) {
      this.params += ch;
      return;
    }
    this.mode = 'text';
    if (this.params.startsWith('?')) return;
    const [a, b] = this.params.split(';').map((x) => (x === '' ? undefined : Number(x)));
    const n = Math.max(1, a ?? 1);
    const clear = (r: number, from: number) => {
      for (let i = Math.min(from, this.cols - 1); i < this.cols; i++) this.grid[r]![i] = ' ';
    };
    switch (ch) {
      case 'H':
        this.r = Math.max(0, Math.min(this.rows - 1, (a ?? 1) - 1));
        this.c = Math.max(0, (b ?? 1) - 1);
        break;
      case 'A':
        this.r = Math.max(this.r >= this.top ? this.top : 0, this.r - n);
        break;
      case 'B':
        this.r = Math.min(this.r <= this.bottom ? this.bottom : this.rows - 1, this.r + n);
        break;
      case 'G':
        this.c = n - 1;
        break;
      case 'K':
        clear(this.r, a === 2 ? 0 : this.c);
        break;
      case 'J':
        if (a === 2) this.grid = this.grid.map(() => this.blank());
        else {
          clear(this.r, this.c);
          for (let r = this.r + 1; r < this.rows; r++) this.grid[r] = this.blank();
        }
        break;
      case 'M':
        if (this.r >= this.top && this.r <= this.bottom) {
          for (let i = 0; i < n; i++) {
            this.grid.splice(this.r, 1);
            this.grid.splice(this.bottom, 0, this.blank());
          }
        }
        this.c = 0;
        break;
      case 'r':
        this.top = (a ?? 1) - 1;
        this.bottom = (b ?? this.rows) - 1;
        this.r = 0;
        this.c = 0;
        break;
      case 'n':
        if (a === 6) this.replies.push([this.r + 1, Math.min(this.c, this.cols - 1) + 1]);
        break;
    }
  }
  private lf(): void {
    if (this.r === this.bottom) {
      const [gone] = this.grid.splice(this.top, 1);
      if (this.top === 0) this.history.push(gone!.join('').trimEnd());
      this.grid.splice(this.bottom, 0, this.blank());
    } else if (this.r < this.rows - 1) this.r++;
  }
}

/** Терминал теста: всё, что пишется, рисует эмулятор; ответ на запрос позиции уходит в onReply. */
class VtTty extends FakeTty {
  vt: Vt;
  onReply: (row: number, col: number) => void = () => {};
  /** Ответы копятся до deliver(): между запросом и ответом можно что-то вывести. */
  defer = false;
  constructor(rows: number, columns: number) {
    super(rows, columns);
    this.vt = new Vt(rows, columns);
  }
  override write(s: string): boolean {
    super.write(s);
    this.vt.feed(s);
    if (!this.defer) this.deliver();
    return true;
  }
  deliver(): void {
    for (let r = this.vt.replies.shift(); r; r = this.vt.replies.shift()) this.onReply(r[0], r[1]);
  }
}

const consoleLog = console.log;

/** Экран лога на эмуляторе: console.log пишет в него же, как в настоящем терминале. */
function term(o: { rows?: number; columns?: number; panel?: boolean } = {}) {
  const out = new VtTty(o.rows ?? 30, o.columns ?? 120);
  if (o.panel !== false) startPanel(out);
  screen.start({ enabled: true, out, logBottom: () => panel.logBottom() });
  out.onReply = (row) => screen.cursor(row);
  console.log = (...a: unknown[]) => void out.write(a.map(String).join(' ') + '\n');
  return {
    out,
    vt: out.vt,
    row: (text: string) => out.vt.row(text),
    lines: () => out.vt.lines(),
    click(text: string): void {
      const y = out.vt.row(text);
      assert.ok(y > 0, `на экране нет «${text}»`);
      screen.click(y);
    },
    done(): void {
      console.log = consoleLog;
      screen.stop();
      panel.stop();
    },
  };
}

const fill = (p: string, n: number) => {
  for (let i = 1; i <= n; i++) log.info(`${p}${String(i).padStart(2, '0')}`);
};
/** Абзацы из пронумерованных слов: по словам видно порядок и полноту раскрытого текста. */
const numbered = (p: string, n: number) => {
  const ws = Array.from({ length: n }, (_, i) => `${p}${String(i + 1).padStart(3, '0')}`);
  const paras: string[] = [];
  for (let i = 0; i < ws.length; i += 60) paras.push(ws.slice(i, i + 60).join(' '));
  return paras.join('\n\n');
};
const lined = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${String(i + 1).padStart(2, '0')}`).join('\n');
const tokens = (s: string, p: string) => s.match(new RegExp(`\\b${p}\\d{3}\\b`, 'g')) ?? [];
const T1240 = numbered('w', 260).slice(0, 1240);

test('экран: модель движения курсора — переводы и переносы строк, сдвиги, ESC7…ESC8, сброс', () => {
  const m = new CursorModel();
  m.feed('abc\n', 120);
  assert.equal(m.moved, 1);
  m.feed('a'.repeat(120) + '\n', 120);
  assert.equal(m.moved, 2, 'ровно в ширину окна — одна строка');
  m.feed('a'.repeat(130) + '\n', 120);
  assert.equal(m.moved, 4);
  const w = new CursorModel();
  w.feed('你'.repeat(30) + '\n', 50);
  assert.equal(w.moved, 2, '60 колонок CJK при ширине 50');
  w.feed('a'.repeat(49) + '你\n', 50);
  assert.equal(w.moved, 4, 'широкий символ в последней колонке переносится');
  w.feed('💬'.repeat(25) + '\n', 50);
  assert.equal(w.moved, 5);
  w.feed('e\u0301'.repeat(50) + '\n', 50);
  assert.equal(w.moved, 6, 'комбинируемые символы без ширины');

  const k = new CursorModel();
  k.feed('x\x1b[3A', 120);
  assert.equal(k.moved, -3);
  k.feed('\x1b[2B\x1b[G', 120);
  assert.deepEqual([k.moved, k.col], [-1, 0]);
  k.feed('\x1b7\x1b[28;1H\x1b[2Kстрока панели\x1b[29;1H\x1b[2K\n\nещё\x1b8', 120);
  assert.deepEqual([k.moved, k.col, k.epoch], [-1, 0, 0], 'кадр панели не двигает курсор лога');
  k.feed('\n\n\n\x1b[3A\x1b[J\x1b7\x1b[1;27r\x1b8', 120);
  k.feed('\x1b7\x1b[r\x1b[28;1H\x1b[2K\x1b[29;1H\x1b[2K\x1b[30;1H\x1b[2K\x1b8', 120);
  assert.deepEqual([k.moved, k.epoch], [-1, 0], 'reserve и release панели');
  k.feed('? Вопрос\n❯ один\n  два\x1b[2A\x1b[10G', 120);
  k.feed('\x1b[2B' + '\x1b[2K\x1b[1A'.repeat(2) + '\x1b[2K\x1b[G? Вопрос\n  один\n❯ два\x1b[2A\x1b[10G', 120);
  k.feed('\x1b[2B' + '\x1b[2K\x1b[1A'.repeat(2) + '\x1b[2K\x1b[G✔ Вопрос два\x1b[13G\n\x1b[G\x1b[?25h', 120);
  assert.deepEqual([k.moved, k.epoch], [0, 0], 'меню inquirer: относительные сдвиги, итог — одна строка');
  k.feed('\x1b]8;;https://x\x07ссылка\x1b]8;;\x07', 120);
  assert.deepEqual([k.moved, k.col], [0, 6], 'OSC без движения');
  k.feed('\x1b[5;1H', 120);
  assert.equal(k.epoch, 1, 'абсолютное позиционирование вне ESC7…ESC8 — сброс');
  k.feed('\x1b[2J', 120);
  assert.equal(k.epoch, 2);

  const sp = new CursorModel();
  sp.feed('\x1b[', 120);
  sp.feed('3A', 120);
  assert.equal(sp.moved, -3, 'последовательность, разрезанная на два write');
});

test('экран: расстояние до курсора по модели совпадает с эмулятором терминала', () => {
  const out = new VtTty(30, 120);
  startPanel(out);
  try {
    const model = new CursorModel();
    const marks: { id: string; base: number }[] = [];
    const put = (s: string) => {
      model.feed(s, 120);
      out.write(s);
    };
    const line = (body: string) => {
      const id = `M${String(marks.length + 1).padStart(3, '0')}`;
      marks.push({ id, base: model.moved });
      put(`${id} ${body}\n`);
    };
    for (let i = 0; i < 12; i++) line('короткая');
    line('длинная '.repeat(40));
    line('emoji 💬 ⚡ 你好 '.repeat(12));
    put('\x1b7\x1b[28;1H\x1b[2Kкадр панели\x1b8');
    // Диалог: панель снята, меню inquirer нарисовано и перерисовано, ответ, панель вернулась.
    put('\x1b7\x1b[r\x1b[28;1H\x1b[2K\x1b[29;1H\x1b[2K\x1b[30;1H\x1b[2K\x1b8');
    put('? Вопрос\n❯ один\n  два\n  три\x1b[3A\x1b[10G');
    put('\x1b[3B' + '\x1b[2K\x1b[1A'.repeat(3) + '\x1b[2K\x1b[G? Вопрос\n  один\n❯ два\n  три\x1b[3A\x1b[10G');
    put('\x1b[3B' + '\x1b[2K\x1b[1A'.repeat(3) + '\x1b[2K\x1b[G✔ Вопрос два\x1b[13G\n\x1b[G\x1b[?25h');
    put('\n\n\n\x1b[3A\x1b[J\x1b7\x1b[1;27r\x1b8');
    for (let i = 0; i < 8; i++) line(i % 2 ? 'после диалога' : 'после диалога '.repeat(12));
    let visible = 0;
    for (const mk of marks) {
      const row = out.vt.row(mk.id + ' ');
      if (!row) continue;
      visible++;
      assert.equal(out.vt.r + 1 - (model.moved - mk.base), row, mk.id);
    }
    assert.ok(visible >= 10 && out.vt.history.some((l) => l.startsWith('M001')), `видно ${visible}`);
  } finally {
    panel.stop();
  }
});

test('размышление без режима мыши: прежняя строка с числом символов', () => {
  const printed: string[] = [];
  console.log = (s: string) => void printed.push(String(s));
  try {
    log.thinking('implementer', 'abcde');
    log.role('implementer', c.gray('… размышляет (5 симв.)'));
    const t = (s: string) => s.replace(/\d\d:\d\d:\d\d/, 'T');
    assert.equal(t(printed[0]!), t(printed[1]!));
  } finally {
    console.log = consoleLog;
  }
});

test('раскрытый текст: форма слова скрытых строк, перенос по ширине, чистка текста', () => {
  assert.deepEqual(
    [1, 2, 5, 21, 25, 32].map(moreLines),
    [1, 2, 5, 21, 25, 32].map((n, i) => `… ещё ${n} ${['строка', 'строки', 'строк', 'строка', 'строк', 'строки'][i]} — целиком в events.jsonl`),
  );
  const lines = thinkingLines('первая\tстрока\x07\x1b[31m\r\n\n\n\nвторая ' + 'слово '.repeat(20) + 'ы'.repeat(30) + ' 你好'.repeat(10) + ' 💬💬\n\n', 24);
  assert.equal(lines[0], 'первая  строка[31m');
  assert.equal(lines[1], '');
  assert.ok(lines.at(-1) !== '');
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i] || lines[i - 1], 'пустые строки схлопнуты');
  for (const l of lines) assert.ok(textWidth(l) <= 24 && !/[\x00-\x1f]/.test(l), l);
  assert.ok(lines.join(' ').includes('ы'.repeat(24)));
  assert.equal(textWidth('a\x1b[90m你💬\x1b[0m'), 5);
  for (const l of wrapText('你好'.repeat(20), 10)) assert.ok(textWidth(l) <= 10);
});

test('экран: клик раскрывает размышление под строкой, лог ниже и панель на месте, история без потерь', () => {
  const t = term();
  try {
    fill('A', 30);
    log.thinking('implementer', T1240);
    fill('B', 3);
    const before = t.lines();
    const y = t.row('▸ размышляет (1240 симв.)');
    t.click('▸ размышляет (1240 симв.)');
    const after = t.lines();
    const h = t.row('▾ размышляет (1240 симв.)');
    assert.ok(h > 0 && h < y, `строка размышления ушла вверх: ${h} < ${y}`);
    assert.equal(t.row('▸ размышляет'), 0);
    assert.deepEqual(tokens(after.slice(h, y).join(' '), 'w'), tokens(T1240, 'w'), 'текст по порядку и целиком');
    for (const b of ['B01', 'B02', 'B03']) assert.equal(t.row(b), before.findIndex((l) => l.includes(b)) + 1, b);
    assert.ok(after[27]!.includes('контроллер') && after[29]!.includes('run r1'), 'панель на месте');
    const all = [...t.vt.history, ...after].join('\n').match(/\bA\d\d\b/g);
    assert.deepEqual(all, Array.from({ length: 30 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`), 'строки выше — в истории, по порядку, без потерь и дублей');
    assert.equal(t.vt.wraps, 0, 'строки текста не переносятся терминалом');
  } finally {
    t.done();
  }
});

test('экран: повторный клик по строке или по тексту сворачивает, лог поднимается вплотную', () => {
  const t = term();
  try {
    fill('A', 30);
    log.thinking('implementer', numbered('w', 80));
    fill('B', 3);
    t.click('▸ размышляет');
    const h = t.row('▾ размышляет');
    t.click('▾ размышляет');
    assert.equal(t.row('▸ размышляет'), h);
    assert.equal(t.row('B01'), h + 1);
    assert.deepEqual(tokens(t.lines().join(' '), 'w'), []);
    t.click('▸ размышляет');
    const h2 = t.row('▾ размышляет');
    assert.deepEqual(tokens(t.lines().join(' '), 'w'), tokens(numbered('w', 80), 'w'), 'текст раскрыт целиком');
    screen.click(h2 + 3);
    assert.equal(t.row('▸ размышляет'), h2, 'клик по строке текста');
    assert.equal(t.row('B01'), h2 + 1);
    log.info('C01');
    assert.equal(t.row('C01'), t.row('B03') + 1, 'следующая строка — сразу под последней');
    const all = [...t.vt.history, ...t.lines()].join('\n');
    assert.equal(all.match(/\bA\d\d\b/g)?.length, 30, 'в истории нет дублей');
  } finally {
    t.done();
  }
});

test('экран: клик мимо размышления ничего не меняет', () => {
  const t = term();
  try {
    fill('A', 10);
    log.thinking('implementer', T1240);
    fill('B', 3);
    const log27 = () => t.lines().slice(0, 27);
    const before = log27();
    for (const y of [t.row('A05'), t.row('B03') + 3, 28, 29, 30]) screen.click(y);
    assert.deepEqual(log27(), before);
  } finally {
    t.done();
  }
});

test('экран: лог продолжается под раскрытым, два размышления, клик по видимой части сворачивает', () => {
  const t = term();
  try {
    fill('A', 30);
    log.thinking('implementer', numbered('x', 40));
    log.thinking('code-reviewer', numbered('y', 40));
    fill('B', 2);
    t.click('code-reviewer');
    t.click('implementer');
    const h = t.row('▾ размышляет (199 симв.)');
    fill('D', 5);
    assert.equal(t.row('▾ размышляет (199 симв.)'), h - 5, 'текст ушёл вверх вместе с логом');
    assert.equal(t.row('D05'), t.vt.r);
    assert.deepEqual(tokens(t.lines().join(' '), 'y'), tokens(numbered('y', 40), 'y'));
    screen.click(h - 5 + 1);
    assert.deepEqual(tokens(t.lines().join(' '), 'x'), [], 'первое свёрнуто');
    assert.deepEqual(tokens(t.lines().join(' '), 'y'), tokens(numbered('y', 40), 'y'), 'второе не тронуто');
    log.info('D06');
    assert.equal(t.row('D06'), t.row('D05') + 1);
  } finally {
    t.done();
  }
});

test('экран: длинное размышление — сколько влезает над строкой и «… ещё N строк»', () => {
  for (const [n, hidden] of [
    [40, '32 строки'],
    [29, '21 строка'],
    [33, '25 строк'],
  ] as const) {
    const t = term();
    try {
      fill('F', 40);
      log.thinking('implementer', lined('L', n));
      fill('E', 16);
      assert.equal(t.row('▸ размышляет'), 10);
      const before = t.lines();
      screen.click(10);
      const after = t.lines();
      assert.equal(t.row('▾ размышляет'), 1);
      for (let i = 1; i <= 8; i++) assert.ok(after[i]!.includes(`L0${i}`), after[i]);
      assert.ok(after[9]!.includes(`… ещё ${hidden} — целиком в events.jsonl`), after[9]);
      assert.deepEqual(after.slice(10, 26), before.slice(10, 26), 'лог ниже на месте');
    } finally {
      t.done();
    }
  }
});

test('экран: строка размышления в первой строке экрана не раскрывается', () => {
  const t = term();
  try {
    fill('F', 40);
    log.thinking('implementer', T1240);
    fill('E', 25);
    assert.equal(t.row('▸ размышляет'), 1);
    const before = [...t.vt.history, ...t.lines()];
    screen.click(1);
    assert.deepEqual([...t.vt.history, ...t.lines()], before);
  } finally {
    t.done();
  }
});

test('экран: узкое окно — строки текста без переноса, строка размышления в две строки экрана', () => {
  for (const columns of [50, 44]) {
    const t = term({ columns });
    try {
      fill('A', 30);
      log.thinking('implementer', 'суперкалифрагилистикэкспиалидоцкийпример 你好世界你好世界你好 💬💬💬 конец');
      fill('B', 2);
      const wraps = t.vt.wraps;
      const b1 = t.row('B01');
      t.click('▸ размышляет');
      assert.ok(t.row('▾ размышляет') > 0);
      for (const l of t.lines()) assert.ok(textWidth(l) <= columns, l);
      assert.ok(t.vt.wraps - wraps <= 1, 'переносится только переписанная строка размышления');
      assert.equal(t.row('B01'), b1);
      assert.ok(t.lines().join('').includes('конец'));
      t.click('▾ размышляет');
      assert.equal(t.row('B01'), t.row('▸ размышляет') + (columns === 44 ? 2 : 1));
    } finally {
      t.done();
    }
  }
});

test('экран: раскрытое размышление ушло за верх — клик по видимому тексту убирает его', () => {
  const t = term();
  try {
    fill('F', 40);
    log.thinking('implementer', lined('K', 10));
    t.click('▸ размышляет');
    assert.equal(t.row('▾ размышляет'), 16);
    fill('G', 20);
    assert.equal(t.row('размышляет'), 0);
    assert.equal(t.row('K05'), 1);
    screen.click(3);
    assert.ok(!t.lines().join(' ').match(/\bK\d\d\b/), 'видимый текст удалён');
    assert.equal(t.row('G01'), 1);
    log.info('Z01');
    assert.equal(t.row('Z01'), t.row('G20') + 1);
    const before = t.lines();
    screen.click(1);
    assert.deepEqual(t.lines(), before, 'запись забыта');
  } finally {
    t.done();
  }
});

test('экран: без панели — вся высота; вывод между запросом позиции и ответом — запрос снова', () => {
  const t = term({ panel: false });
  try {
    fill('A', 40);
    log.thinking('implementer', T1240);
    log.info('B01');
    t.out.defer = true;
    t.click('▸ размышляет');
    log.info('B02');
    const asked = () => t.out.writes.filter((w) => w.includes('\x1b[6n')).length;
    assert.equal(asked(), 1);
    t.out.deliver();
    assert.equal(asked(), 2, 'позиция устарела — второй запрос');
    t.out.deliver();
    assert.ok(t.row('▾ размышляет (1240 симв.)') > 0, 'раскрыто то, по чему кликнули, хотя лог успел сдвинуться');
    assert.ok(t.out.writes.some((w) => w.includes('\x1b[r\x1b8')), 'область во всю высоту');
    assert.equal(t.row('B02'), 30 - 1);
    t.out.defer = false;
    t.click('▾ размышляет');
    assert.equal(t.row('B01'), t.row('▸ размышляет') + 1);
  } finally {
    t.done();
  }
});

test('экран: после изменения размера окна прежние размышления не раскрываются, новые — да', () => {
  const t = term();
  try {
    fill('A', 5);
    log.thinking('implementer', T1240);
    t.out.columns = 110;
    t.out.emit('resize');
    t.click('▸ размышляет');
    assert.equal(t.row('▾'), 0);
    log.thinking('code-reviewer', T1240);
    t.click('code-reviewer │');
    assert.ok(t.row('▾ размышляет') > 0 && t.lines()[t.row('▾ размышляет') - 1]!.includes('code-reviewer'));
  } finally {
    t.done();
  }
});

test('экран: размышление под удержанием лога встаёт на экран при release, пустое — без пометки', () => {
  const t = term();
  try {
    fill('A', 5);
    log.hold();
    log.thinking('implementer', T1240);
    assert.equal(t.row('размышляет'), 0);
    log.release();
    t.click('▸ размышляет (1240 симв.)');
    assert.ok(t.row('▾ размышляет (1240 симв.)') > 0);
    log.thinking('implementer', '  ');
    assert.ok(t.row('… размышляет (2 симв.)') > 0);
  } finally {
    t.done();
  }
});

class FakeStdin extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  flowing = false;
  setRawMode(mode: boolean): this {
    this.raw.push(mode);
    return this;
  }
  resume(): this {
    this.flowing = true;
    return this;
  }
  pause(): this {
    this.flowing = false;
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

test('мышь: разбор ввода терминала', () => {
  const p = new InputParser();
  assert.deepEqual(p.feed('\x1b[<0;5;7M\x1b[<0;5;7m'), [
    { kind: 'press', button: 0, x: 5, y: 7 },
    { kind: 'release', button: 0, x: 5, y: 7 },
  ]);
  assert.deepEqual(p.feed('\x1b[<2;1;1M\x1b[<32;3;3M'), [{ kind: 'press', button: 2, x: 1, y: 1 }, { kind: 'motion' }]);
  assert.deepEqual(p.feed('\x1b[<64;3;3M\x1b[<65;3;3M'), [
    { kind: 'wheel', up: true },
    { kind: 'wheel', up: false },
  ]);
  assert.deepEqual(p.feed('\x1b[12;1R'), [{ kind: 'cursor', row: 12, col: 1 }]);
  assert.deepEqual(p.feed('ab\x03'), [{ kind: 'interrupt' }]);
  assert.deepEqual(p.feed('\x1b[<0;1'), []);
  assert.deepEqual(p.feed('0;20M'), [{ kind: 'press', button: 0, x: 10, y: 20 }]);
  assert.deepEqual(p.feed('\x1b[2'), []);
  assert.deepEqual(p.feed('7;1R'), [{ kind: 'cursor', row: 27, col: 1 }]);
  assert.deepEqual(p.feed('\x1bOA\x1b[Aq'), [], 'стрелки и буквы — мимо');
});

test('мышь: включение, клик, колесо с паузой, Ctrl+C группе, пауза диалога, идемпотентный stop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const input = new FakeStdin();
  const writes: string[] = [];
  const out = { write: (s: string) => void writes.push(s) };
  const clicks: number[][] = [];
  const cursors: number[][] = [];
  const kills: unknown[][] = [];
  const kill = process.kill;
  process.kill = ((...a: unknown[]) => (kills.push(a), true)) as typeof process.kill;
  const sigint = process.listenerCount('SIGINT');
  const handlers = { click: (x: number, y: number) => void clicks.push([x, y]), cursor: (r: number, col: number) => void cursors.push([r, col]) };
  try {
    mouse.start({ enabled: false, input, out, handlers });
    assert.equal(writes.length, 0);
    mouse.start({ enabled: true, input, out, handlers });
    assert.equal(writes.at(-1), '\x1b[?1000h\x1b[?1006h');
    assert.ok(input.raw.at(-1) && input.flowing);
    assert.equal(process.listenerCount('SIGINT'), sigint + 1);
    input.emit('data', '\x1b[<0;3;4M\x1b[<0;3;4m\x1b[<2;3;4M\x1b[<32;3;4M');
    assert.deepEqual(clicks, [[3, 4]]);
    input.emit('data', '\x1b[9;1R');
    assert.deepEqual(cursors, [[9, 1]]);
    input.emit('data', '\x03');
    assert.deepEqual(kills, [[0, 'SIGINT']]);
    input.emit('data', '\x1b[<64;1;1M');
    assert.equal(writes.at(-1), '\x1b[?1000l');
    const n = writes.length;
    input.emit('data', '\x1b[<64;1;1M');
    assert.equal(writes.length, n, 'дальше колесо терминала, а не наше');
    t.mock.timers.tick(WHEEL_PAUSE_MS - 1);
    assert.equal(writes.length, n);
    t.mock.timers.tick(1);
    assert.equal(writes.at(-1), '\x1b[?1000h');
    input.emit('data', '\x1b[<64;1;1M');
    mouse.pause();
    assert.equal(writes.at(-1), '\x1b[?1000l\x1b[?1006l');
    assert.ok(!input.raw.at(-1) && !input.flowing && input.listenerCount('data') === 0);
    t.mock.timers.tick(WHEEL_PAUSE_MS);
    assert.equal(writes.at(-1), '\x1b[?1000l\x1b[?1006l', 'пауза колеса не включает отчёт во время диалога');
    mouse.resume();
    assert.equal(writes.at(-1), '\x1b[?1000h\x1b[?1006h');
    assert.ok(input.raw.at(-1));
    mouse.stop();
    assert.equal(writes.at(-1), '\x1b[?1000l\x1b[?1006l');
    assert.ok(!input.raw.at(-1) && input.listenerCount('data') === 0);
    assert.equal(process.listenerCount('SIGINT'), sigint);
    const m = writes.length;
    mouse.stop();
    assert.equal(writes.length, m);
  } finally {
    process.kill = kill;
    mouse.stop();
  }
});

test('колесо: клик через 2 с после прокрутки раскрывает размышление', (tt) => {
  tt.mock.timers.enable({ apis: ['setTimeout'] });
  const t = term();
  const input = new FakeStdin();
  mouse.start({ enabled: true, input, out: t.out, handlers: { click: (_x, y) => screen.click(y), cursor: (row) => screen.cursor(row) } });
  t.out.onReply = (row, col) => void input.emit('data', `\x1b[${row};${col}R`);
  try {
    fill('A', 20);
    log.thinking('implementer', numbered('w', 80));
    log.info('после размышления');
    for (let i = 0; i < 3; i++) input.emit('data', '\x1b[<65;5;5M');
    tt.mock.timers.tick(2_000);
    const w = t.out.writes;
    assert.ok(w.lastIndexOf('\x1b[?1000h') > w.lastIndexOf('\x1b[?1000l'), 'перехват снова включён');
    const y = t.row('▸ размышляет');
    input.emit('data', `\x1b[<0;5;${y}M\x1b[<0;5;${y}m`);
    assert.ok(t.row('▾ размышляет') > 0);
    assert.deepEqual(tokens(t.lines().join(' '), 'w'), tokens(numbered('w', 80), 'w'));
  } finally {
    mouse.stop();
    t.done();
  }
});

test('режим мыши включается только при TTY stdin и stdout без --no-mouse', () => {
  const on = { stdinTTY: true, stdoutTTY: true, env: {} };
  assert.equal(mouseEnabled(on), true);
  assert.equal(mouseEnabled({ ...on, stdinTTY: false }), false);
  assert.equal(mouseEnabled({ ...on, stdoutTTY: undefined }), false);
  assert.equal(mouseEnabled({ ...on, noMouse: true }), false);
  assert.equal(mouseEnabled({ ...on, env: { AGENTFLOW_NO_MOUSE: '1' } }), false);
});

test('диалог: режим мыши снят на время меню, размышление до диалога раскрывается после', async () => {
  const t = term();
  const input = new FakeStdin();
  mouse.start({ enabled: true, input, out: t.out, handlers: { click: (_x, y) => screen.click(y), cursor: (row) => screen.cursor(row) } });
  t.out.onReply = (row, col) => void input.emit('data', `\x1b[${row};${col}R`);
  const click = (text: string) => input.emit('data', `\x1b[<0;5;${t.row(text)}M\x1b[<0;5;${t.row(text)}m`);
  try {
    fill('A', 20);
    log.thinking('spec-author', numbered('w', 80));
    log.info('после размышления');
    let during: unknown;
    const io: PromptIO = {
      select: async (cfg) => {
        during = { raw: input.raw.at(-1), listeners: input.listenerCount('data') };
        t.out.write('? Вопрос\n❯ один\n  два\n  три\x1b[3A\x1b[10G');
        t.out.write('\x1b[3B' + '\x1b[2K\x1b[1A'.repeat(3) + '\x1b[2K\x1b[G? Вопрос\n  один\n❯ два\n  три\x1b[3A\x1b[10G');
        click('▸ размышляет');
        t.out.write('\x1b[3B' + '\x1b[2K\x1b[1A'.repeat(3) + '\x1b[2K\x1b[G✔ Вопрос один\x1b[15G\n\x1b[G\x1b[?25h');
        return cfg.default!;
      },
      input: async () => '',
      tty: () => true,
    };
    const key = await new Human(false, io).select({ title: 'Вопрос', options: [{ key: 'a', label: 'один' }, { key: 'b', label: 'два' }], recommended: 'a', rationale: 'r' });
    assert.equal(key, 'a');
    assert.deepEqual(during, { raw: false, listeners: 0 });
    assert.equal(t.row('▾'), 0, 'во время диалога клик не раскрыл');
    assert.ok(!t.out.writes.some((w) => w.includes('\x1b[6n')), 'позиция не запрашивалась');
    assert.ok(input.raw.at(-1) && input.listenerCount('data') === 1, 'после диалога режим мыши снова включён');
    click('▸ размышляет');
    const h = t.row('▾ размышляет');
    assert.ok(h > 0 && t.lines()[h - 1]!.includes('spec-author'));
    assert.deepEqual(tokens(t.lines().join(' '), 'w'), tokens(numbered('w', 80), 'w'));
  } finally {
    mouse.stop();
    t.done();
  }
});
