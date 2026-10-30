// Unit-тесты дерева run: основное дерево или worktree, lock, грязное дерево, merge, путь к контракту ревью.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchExists, currentBranch, ensureIgnored, gitPath, switchNew } from './git.ts';
import { writeAcceptanceReport } from './report.ts';
import { contractExample } from './review-validator.ts';
import { foreignDirty, inMainTree, lockTree, mergeSteps, treeChanges } from './run-tree.ts';
import type { RunState } from './state.ts';
import { exec } from './util.ts';

test('дерево run: основное, если worktree — сам репозиторий', () => {
  assert.equal(inMainTree({ worktree: '/repo', repoRoot: '/repo' }), true);
  assert.equal(inMainTree({ worktree: '/repo/.agentflow-runs/r/worktree', repoRoot: '/repo' }), false);
});

test('грязное дерево: каталог прогонов и сам change не в счёт', () => {
  const dirty = ['.agentflow-runs/r/ACCEPTANCE.md', 'openspec/changes/add-x/proposal.md', 'openspec/changes/other/a.md', 'src/a.js'];
  assert.deepEqual(treeChanges(dirty), dirty.slice(1));
  assert.deepEqual(foreignDirty(dirty, 'add-x'), ['openspec/changes/other/a.md', 'src/a.js']);
});

test('merge: из основного дерева — назад на исходную ветку, из worktree — ещё и его удаление', () => {
  assert.deepEqual(mergeSteps({ repoRoot: '/r', worktree: '/r', branch: 'agentflow/x', startBranch: 'main' }), ['git -C /r switch main', 'git -C /r merge agentflow/x']);
  assert.deepEqual(mergeSteps({ repoRoot: '/r', worktree: '/r', branch: 'agentflow/x' }), ['git -C /r merge agentflow/x']);
  assert.deepEqual(mergeSteps({ repoRoot: '/r', worktree: '/r/w', branch: 'agentflow/x' }), ['git -C /r merge agentflow/x', 'git -C /r worktree remove /r/w']);
});

test('lock основного дерева: живой процесс не пускает второй run, упавший — снимается', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'agentflow-lock-')), 'git', 'agentflow.lock');
  const release = lockTree(path, 'r1');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { runId: 'r1', pid: process.pid });
  // Свой же процесс (resume после run в одном процессе) lock перехватывает.
  lockTree(path, 'r1');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
  try {
    writeFileSync(path, JSON.stringify({ runId: 'r0', pid: other.pid }));
    assert.throws(() => lockTree(path, 'r2'), /уже идёт run r0 .*--worktree/);
  } finally {
    other.kill();
  }
  await new Promise((r) => other.once('exit', r));
  const again = lockTree(path, 'r2');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).runId, 'r2');
  release(); // чужой lock не снимает
  assert.ok(existsSync(path));
  again();
  assert.ok(!existsSync(path));
});

test('git: ветка run в основном дереве и игнор каталога прогонов через .git/info/exclude', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'agentflow-tree-'));
  const run = async (...args: string[]) => assert.equal((await exec('git', args, { cwd: repo })).code, 0, args.join(' '));
  await run('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  await run('add', '-A');
  await run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  assert.equal(await currentBranch(repo), 'main');
  writeFileSync(join(repo, 'a.txt'), 'dirty\n');
  await switchNew(repo, 'agentflow/x');
  assert.equal(await currentBranch(repo), 'agentflow/x');
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'dirty\n', 'незакоммиченное переходит на ветку run');
  assert.ok(await branchExists(repo, 'agentflow/x'));
  assert.ok(!(await branchExists(repo, 'agentflow/y')));
  assert.equal(await gitPath(repo, 'agentflow.lock'), join(repo, '.git', 'agentflow.lock'));
  assert.equal(await ensureIgnored(repo, '.agentflow-runs/r/state.json', '/.agentflow-runs/'), true);
  assert.equal(await ensureIgnored(repo, '.agentflow-runs/r/state.json', '/.agentflow-runs/'), false, 'второй раз не дописывает');
  assert.match(readFileSync(join(repo, '.git/info/exclude'), 'utf8'), /^\/\.agentflow-runs\/$/m);
});

test('контракт ревью: промпт ссылается на копию схемы в контекстах run', () => {
  const text = contractExample({ role: 'spec-reviewer', target: 'proposal', snapshotId: 'sha256:x', round: 1, schema: '/run/contexts/review.schema.json' });
  assert.match(text, /ровно по контракту \(JSON Schema: \/run\/contexts\/review\.schema\.json\):/);
  assert.doesNotMatch(text, /\.agentflow\/review\.schema\.json/);
});

test('отчёт приёмки основного дерева: ветка от исходной, merge без worktree remove', () => {
  const s = {
    runId: 'r',
    change: 'add-slugify',
    status: 'accepted',
    branch: 'agentflow/add-slugify',
    startBranch: 'main',
    worktree: '/repo',
    repoRoot: '/repo',
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
  } as unknown as RunState;
  const md = readFileSync(writeAcceptanceReport(mkdtempSync(join(tmpdir(), 'agentflow-tree-')), s, ''), 'utf8');
  assert.match(md, /- ветка: `agentflow\/add-slugify` от `main`, основное дерево: `\/repo`/);
  assert.match(md, /git -C \/repo switch main\ngit -C \/repo merge agentflow\/add-slugify\n```/);
  assert.doesNotMatch(md, /worktree remove/);
});
