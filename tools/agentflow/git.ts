// Git-операции делает контроллер, а не роли: ветка и worktree на change, коммиты, diff.
import { exec } from './util.ts';

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await exec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function ensureRepo(root: string): Promise<void> {
  const r = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root });
  if (r.code !== 0) throw new Error('каталог не git-репозиторий: выполни git init && git add -A && git commit -m init');
  const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  if (head.code !== 0) throw new Error('в репозитории нет коммитов: выполни git add -A && git commit -m init');
}

export async function head(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function addWorktree(root: string, path: string, branch: string): Promise<void> {
  await git(root, ['worktree', 'add', '-b', branch, path, 'HEAD']);
}

/** Изменённые и новые файлы относительно HEAD (с учётом .gitignore). */
export async function changedPaths(cwd: string): Promise<string[]> {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
}

/** Коммит всего изменённого; возвращает новый HEAD или прежний, если нечего коммитить. */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '-A']);
  const staged = await exec('git', ['diff', '--cached', '--quiet'], { cwd });
  if (staged.code !== 0) {
    await git(cwd, ['-c', 'user.name=agentflow', '-c', 'user.email=agentflow@localhost', 'commit', '-q', '-m', message]);
  }
  return head(cwd);
}

export async function diff(cwd: string, from: string, to: string): Promise<string> {
  return git(cwd, ['diff', `${from}..${to}`]);
}

export async function diffNoIndex(cwd: string, a: string, b: string): Promise<string> {
  const r = await exec('git', ['diff', '--no-index', '--', a, b], { cwd });
  return r.stdout;
}
