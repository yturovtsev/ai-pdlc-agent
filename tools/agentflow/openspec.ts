// Обёртка над OpenSpec CLI: граф артефактов, инструкции, валидация, archive.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

export class OpenSpec {
  private readonly bin: string;

  constructor(repoRoot: string, private readonly cwd: string) {
    const local = join(repoRoot, 'node_modules/.bin/openspec');
    this.bin = existsSync(local) ? local : 'openspec';
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

  async newChange(change: string, schema: string, description: string): Promise<void> {
    if (existsSync(join(this.cwd, 'openspec/changes', change))) return;
    const r = await this.run(['new', 'change', change, '--schema', schema, '--description', description]);
    if (r.code !== 0) throw new Error(`openspec new change: ${r.err || r.out}`);
  }

  async artifacts(change: string): Promise<ArtifactNode[]> {
    const s = await this.json<{ artifacts: ArtifactNode[] }>(['status', '--change', change]);
    return s.artifacts.map((a) => ({ ...a, requires: a.requires ?? [] }));
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
