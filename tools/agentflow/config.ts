// Где что лежит: kit (этот репозиторий: код контроллера и настройки по умолчанию) и целевой
// репозиторий (git-корень, из которого запущен agentflow). Настройки целевого репозитория
// в .agentflow/ накладываются поверх kit: policy.yaml сливается, agents/ и rubrics/ заменяют
// одноимённые файлы.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exec } from './util.ts';

/** Каталог kit: tools/agentflow/../.. */
export const KIT = resolve(import.meta.dirname, '../..');

/** Каталог с agentflow-gate: контроллер добавляет его в PATH сессий ролей. */
export const KIT_BIN = join(KIT, 'tools/agentflow/bin');

/** Git-корень, из которого запущен agentflow. npm run меняет cwd на kit, но оставляет INIT_CWD. */
export async function resolveRepo(explicit?: string): Promise<string> {
  const from = resolve(explicit ?? process.env['INIT_CWD'] ?? process.cwd());
  const r = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: from });
  if (r.code !== 0) throw new Error(`${from} — не git-репозиторий: запусти agentflow из корня репозитория или передай --repo`);
  return r.stdout.trim();
}

/** Файл настройки: сначала целевой репозиторий (.agentflow/<rel>), затем kit (<kitRel>). */
export function layered(repo: string, rel: string, kitRel = rel): string {
  const own = join(repo, '.agentflow', rel);
  return existsSync(own) ? own : join(KIT, kitRel);
}

export function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}
