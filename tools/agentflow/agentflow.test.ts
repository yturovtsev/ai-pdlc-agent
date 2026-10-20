// Офлайн-тесты детерминированных узлов: контракт ревью, правила принятия, ACL, tasks, glob, выбор схемы OpenSpec, панель статуса.
//   npm run test:agentflow
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchesFromTasks, parseTasks } from './context-builder.ts';
import { deepMerge, KIT } from './config.ts';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { OpenSpec } from './openspec.ts';
import { decide, validateReview, type Expectation } from './review-validator.ts';
import { apiErrorIn, decideAcl, describeTask, mcpViolations, mcpWarnings, sessionTools, type RoleDef, type RoleRuntime } from './roles.ts';
import type { Policy } from './policy.ts';
import { normalize } from './snapshot.ts';
import { globToRegExp } from './util.ts';
import { log } from './log.ts';
import { fit, panel, panelEnabled, renderPanel, stripAnsi, type PanelState } from './status-panel.ts';

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
  const [top, bottom] = renderPanel(panelState({ agent, loop: { name: 'batch-1', round: 2, max: 3 } }), 200, 126_000);
  for (const part of ['▶ implementer 02:05 · батч 2', 'qwen3-coder', 'effort high', 'новая сессия', 'инстр. 3', 'запуск 7', 'ролей 5']) assert.ok(top.includes(part), part);
  for (const part of ['⏱ 02:06', 'петля «batch-1» 2/3', 'ФАЗА APPLY', 'change demo', 'run 20261020-1200-demo']) assert.ok(bottom.includes(part), part);
  assert.ok(renderPanel(panelState({ agent: { ...agent, resume: true } }), 200, 2_000)[0].includes('продолжение сессии'));
  const [idle] = renderPanel(panelState(), 200, 3_723_000);
  assert.ok(idle.startsWith('⚙ контроллер') && idle.includes('гейт lint: зелёный'));
  assert.ok(renderPanel(panelState(), 200, 3_723_000)[1].includes('⏱ 1:02:03'));
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
  const [top, bottom] = renderPanel(panelState({ phase: long }), 40, 0);
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
  /** Последний кадр панели: текст двух нижних строк без ANSI. */
  frame(): string[] {
    const at = `\x1b[${this.rows - 1};1H`;
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
  assert.ok(out.all.includes('\x1b[1;28r'));
  assert.equal(process.listenerCount('SIGINT'), sigint + 1);
  out.rows = 24;
  out.columns = 60;
  out.emit('resize');
  assert.ok(out.all.includes('\x1b[1;22r'));
  const f = out.frame();
  assert.equal(f.length, 2);
  for (const l of f) assert.ok([...l].length <= 60, l);
  panel.stop();
  assert.ok(out.writes.at(-1)!.includes('\x1b[?25h'));
  assert.ok(out.all.lastIndexOf('\x1b[r') > out.all.lastIndexOf('\x1b[1;22r'));
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
  let [top, bottom] = out.frame();
  assert.ok(top!.includes('▶ implementer') && top!.includes('батч 1') && top!.includes('запуск 1') && top!.includes('инстр. 1'), top);
  assert.ok(bottom!.includes('петля «batch-1» 2/3'), bottom);
  log.roleDone('implementer', { turns: 1, seconds: 0, models: [], denials: 0 });
  log.gate('lint', true, '');
  [top] = out.frame();
  assert.ok(top!.startsWith('⚙ контроллер') && top!.includes('гейт lint'), top);

  panel.pause();
  assert.ok(out.writes.at(-1)!.includes('\x1b[r'));
  const n = out.writes.length;
  log.step('во время диалога');
  assert.equal(out.writes.length, n);
  panel.resume();
  assert.ok(out.writes.slice(n).join('').includes('\x1b[1;28r'));
  log.loopClose('PASS');
  panel.stop();
});

test('цель вызова роли для панели: по виду шага', () => {
  assert.equal(describeTask({ kind: 'clarify' }), 'уточнение intent');
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
