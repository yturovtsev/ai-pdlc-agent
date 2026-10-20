// Офлайн-тесты детерминированных узлов: контракт ревью, правила принятия, ACL, tasks, glob, выбор схемы OpenSpec.
//   npm run test:agentflow
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchesFromTasks, parseTasks } from './context-builder.ts';
import { deepMerge, KIT } from './config.ts';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { OpenSpec } from './openspec.ts';
import { decide, validateReview, type Expectation } from './review-validator.ts';
import { decideAcl, mcpViolations, mcpWarnings, sessionTools, type RoleDef, type RoleRuntime } from './roles.ts';
import type { Policy } from './policy.ts';
import { normalize } from './snapshot.ts';
import { globToRegExp } from './util.ts';

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
