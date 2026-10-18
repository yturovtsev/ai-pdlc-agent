// Офлайн-тесты детерминированных узлов: контракт ревью, правила принятия, ACL, tasks, glob.
//   npm run test:agentflow
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks } from './context-builder.ts';
import { decide, validateReview, type Expectation } from './review-validator.ts';
import { decideAcl, type RoleRuntime } from './roles.ts';
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
    roles: {
      'spec-author': { write: ['openspec/changes/{change}/**'], shell: [] },
      implementer: { write: ['**'], denyWrite: ['openspec/**', 'e2e/**'], shell: ['lint', 'unit'] },
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
  assert.ok(decideAcl(rt, 'implementer', false, 'run_shell_command', { command: './tools/agentflow/run.sh lint' }).ok);
  assert.equal(decideAcl(rt, 'implementer', false, 'run_shell_command', { command: './tools/agentflow/run.sh e2e' }).ok, false);
  assert.equal(decideAcl(rt, 'implementer', false, 'run_shell_command', { command: './tools/agentflow/run.sh lint && git push' }).ok, false);
});

test('ACL: ревьюер не пишет, шаг readOnly не пишет никому', () => {
  assert.equal(decideAcl(rt, 'code-reviewer', false, 'write_file', { file_path: 'src/a.js' }).ok, false);
  assert.equal(decideAcl(rt, 'implementer', true, 'write_file', { file_path: 'src/a.js' }).ok, false);
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
