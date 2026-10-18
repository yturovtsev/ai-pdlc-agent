import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthType } from '@qwen-code/sdk';
import { parse } from 'yaml';
import { sha256 } from './util.ts';

export type GateOp = string;

export interface RolePolicy {
  write: string[];
  denyWrite?: string[];
  shell: GateOp[];
}

export interface Policy {
  version: number;
  qwen: { executable: string; authType?: string; effortViaSdk: boolean; debug: boolean };
  openspec: { schema: string };
  limits: {
    artifactRounds: number;
    holisticRounds: number;
    batchRounds: number;
    finalFixRounds: number;
    gateAttempts: number;
    infraRetries: number;
    roleTimeoutMinutes: number;
  };
  git: { branchPrefix: string };
  gates: { batch: GateOp[]; full: GateOp[] };
  roles: Record<string, RolePolicy>;
  denyAll: string[];
  sha: string;
}

export function loadPolicy(repoRoot: string): Policy {
  const text = readFileSync(join(repoRoot, '.agentflow/policy.yaml'), 'utf8');
  const p = parse(text) as Omit<Policy, 'sha'>;
  for (const key of ['qwen', 'openspec', 'limits', 'git', 'gates', 'roles'] as const) {
    if (!p[key]) throw new Error(`.agentflow/policy.yaml: нет секции ${key}`);
  }
  return { ...p, denyAll: p.denyAll ?? [], sha: sha256(text) };
}

/** --auth-type для SDK: только если задан в policy (корпоративный CLI обычно преднастроен). */
export function qwenAuthType(policy: Policy): AuthType | undefined {
  return (policy.qwen.authType || undefined) as AuthType | undefined;
}

/** Путь к CLI для SDK: undefined — встроенный в @qwen-code/sdk. */
export function qwenExecutable(policy: Policy): string | undefined {
  const value = process.env['AGENTFLOW_QWEN_CLI'] ?? policy.qwen.executable;
  return !value || value === 'bundled' ? undefined : value;
}
