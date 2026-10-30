// Где run меняет код: в основном дереве репозитория (по умолчанию) или в своём worktree (--worktree).
// Логи, контексты, ревью и состояние в обоих случаях — в каталоге run .agentflow-runs/<run-id>/.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const RUNS_DIR = '.agentflow-runs';
/** Lock основного дерева — в каталоге git (git rev-parse --git-path), а не в дереве: иначе он попал бы в коммит. */
export const TREE_LOCK = 'agentflow.lock';

/** Run работает в основном дереве: worktree в state.json — сам репозиторий. */
export const inMainTree = (s: { worktree: string; repoRoot: string }): boolean => s.worktree === s.repoRoot;

/** Правки дерева без каталога прогонов: его пишет только контроллер (отчёт приёмки в нём не игнорируется). */
export const treeChanges = (paths: readonly string[]): string[] => paths.filter((p) => !p.startsWith(`${RUNS_DIR}/`));

/** Незакоммиченное вне change и каталога run: в основном дереве оно попадёт в первый коммит контроллера. */
export function foreignDirty(dirty: readonly string[], change: string): string[] {
  return treeChanges(dirty).filter((p) => !p.startsWith(`openspec/changes/${change}/`));
}

export interface TreeLock {
  runId: string;
  pid: number;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM — процесс есть, но чужой.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Основное дерево одно — run в нём тоже один. Lock живого процесса — ошибка с его run-id;
 * lock упавшего процесса снимается. Возвращает функцию снятия.
 */
export function lockTree(path: string, runId: string, pid = process.pid): () => void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    let held: TreeLock | undefined;
    try {
      held = JSON.parse(readFileSync(path, 'utf8')) as TreeLock;
    } catch {
      held = undefined;
    }
    if (held && held.pid !== pid && alive(held.pid)) {
      throw new Error(`в основном дереве уже идёт run ${held.runId} (pid ${held.pid}): дождись его или запусти этот с --worktree`);
    }
  }
  writeFileSync(path, JSON.stringify({ runId, pid } satisfies TreeLock));
  return () => {
    try {
      const held = JSON.parse(readFileSync(path, 'utf8')) as TreeLock;
      if (held.pid === pid && held.runId === runId) unlinkSync(path);
    } catch {
      // lock уже снят
    }
  };
}

/** Как влить ветку run: из основного дерева — вернуться на исходную ветку, из worktree — ещё и убрать его. */
export function mergeSteps(s: { repoRoot: string; worktree: string; branch: string; startBranch?: string }): string[] {
  if (inMainTree(s)) return [...(s.startBranch ? [`git -C ${s.repoRoot} switch ${s.startBranch}`] : []), `git -C ${s.repoRoot} merge ${s.branch}`];
  return [`git -C ${s.repoRoot} merge ${s.branch}`, `git -C ${s.repoRoot} worktree remove ${s.worktree}`];
}
