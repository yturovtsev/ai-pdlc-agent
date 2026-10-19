// Обёртка над OpenSpec CLI: граф артефактов, инструкции, валидация, archive.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { KIT } from './config.ts';
import { exec } from './util.ts';

export interface ArtifactNode {
  id: string;
  outputPath: string;
  status: 'done' | 'ready' | 'blocked' | string;
  requires: string[];
}

export interface Instructions {
  instruction?: string;
  template?: string;
  description?: string;
  outputPath?: string;
  context?: string;
  rules?: unknown;
  dependencies?: { id: string; path: string; done: boolean }[];
  [key: string]: unknown;
}

export interface ApplyTask {
  id: string;
  description: string;
  done: boolean;
  sourcePath: string;
  line: number;
}

export class OpenSpec {
  readonly bin: string;

  /** OpenSpec целевого репозитория (его версия и конфигурация), иначе из kit, иначе из PATH. */
  constructor(repo: string, private readonly cwd: string) {
    const own = join(repo, 'node_modules/.bin/openspec');
    const kit = join(KIT, 'node_modules/.bin/openspec');
    this.bin = existsSync(own) ? own : existsSync(kit) ? kit : 'openspec';
  }

  private async run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const r = await exec(this.bin, args, { cwd: this.cwd, env: { ...process.env, NO_COLOR: '1' } });
    return { code: r.code, out: r.stdout, err: r.stderr };
  }

  private async json<T>(args: string[]): Promise<T> {
    const r = await this.run([...args, '--json']);
    try {
      return JSON.parse(r.out) as T;
    } catch {
      throw new Error(`openspec ${args.join(' ')}: не JSON (код ${r.code}): ${(r.err || r.out).slice(0, 500)}`);
    }
  }

  async version(): Promise<string> {
    const r = await this.run(['--version']);
    return r.out.trim() || 'unknown';
  }

  /** Новый change; схема — из openspec/config.yaml репозитория, если не задана явно. */
  async newChange(change: string, schema: string | undefined, description: string): Promise<void> {
    if (existsSync(join(this.cwd, 'openspec/changes', change))) return;
    const r = await this.run(['new', 'change', change, ...(schema ? ['--schema', schema] : []), '--description', description]);
    if (r.code !== 0) throw new Error(`openspec new change: ${r.err || r.out}`);
  }

  /** Граф артефактов схемы change (схема change из .openspec.yaml или config.yaml). */
  async status(change: string): Promise<{ schemaName: string; artifacts: ArtifactNode[]; applyRequires: string[] }> {
    const s = await this.json<{ schemaName: string; artifacts: ArtifactNode[]; applyRequires?: string[] }>(['status', '--change', change]);
    return { schemaName: s.schemaName, artifacts: s.artifacts.map((a) => ({ ...a, requires: a.requires ?? [] })), applyRequires: s.applyRequires ?? [] };
  }

  async artifacts(change: string): Promise<ArtifactNode[]> {
    return (await this.status(change)).artifacts;
  }

  /** Задачи apply в разборе самого OpenSpec: файл и строка каждой задачи (apply.tracks схемы). */
  async applyTasks(change: string): Promise<ApplyTask[]> {
    const a = await this.json<{ tasks?: ApplyTask[] }>(['instructions', 'apply', '--change', change]);
    return a.tasks ?? [];
  }

  async list(): Promise<{ name: string; completedTasks: number; totalTasks: number; status: string; lastModified: string }[]> {
    return (await this.json<{ changes: { name: string; completedTasks: number; totalTasks: number; status: string; lastModified: string }[] }>(['list'])).changes;
  }

  instructions(artifact: string, change: string): Promise<Instructions> {
    return this.json<Instructions>(['instructions', artifact, '--change', change]);
  }

  async validate(change: string): Promise<{ valid: boolean; issues: { level: string; path: string; message: string }[] }> {
    const r = await this.json<{ items: { valid: boolean; issues: { level: string; path: string; message: string }[] }[] }>([
      'validate',
      change,
      '--strict',
      '--no-interactive',
    ]);
    const item = r.items[0];
    return { valid: !!item?.valid, issues: item?.issues ?? [] };
  }

  async archive(change: string): Promise<string> {
    const r = await this.run(['archive', change, '--yes']);
    if (r.code !== 0) throw new Error(`openspec archive: ${r.err || r.out}`);
    return r.out;
  }
}

/** Топологический порядок артефактов по requires. */
export function topoOrder(nodes: ArtifactNode[]): ArtifactNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: ArtifactNode[] = [];
  const visit = (n: ArtifactNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    for (const r of n.requires) {
      const dep = byId.get(r);
      if (dep) visit(dep);
    }
    out.push(n);
  };
  nodes.forEach(visit);
  return out;
}

/** Все артефакты, которые транзитивно зависят от изменённых. */
export function downstreamOf(nodes: ArtifactNode[], changed: Set<string>): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (changed.has(n.id) || out.has(n.id)) continue;
      if (n.requires.some((r) => changed.has(r) || out.has(r))) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}
