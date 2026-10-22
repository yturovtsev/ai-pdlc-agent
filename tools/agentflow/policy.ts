import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthType } from '@qwen-code/sdk';
import { parse } from 'yaml';
import { KIT, KIT_BIN, deepMerge } from './config.ts';
import { sha256 } from './util.ts';

export type GateOp = string;

export interface RolePolicy {
  write: string[];
  denyWrite?: string[];
  shell: GateOp[];
  /** Шаблоны имён MCP-инструментов (`mcp__<server>__<tool>`, `*`); нет ключа — MCP запрещён. */
  mcp?: string[];
}

export interface Policy {
  version: number;
  qwen: { executable: string; authType?: string; effortViaSdk: boolean; apiTimeoutSeconds?: number; debug: boolean };
  openspec: { schema: string };
  limits: {
    artifactRounds: number;
    holisticRounds: number;
    batchRounds: number;
    finalFixRounds: number;
    gateAttempts: number;
    infraRetries: number;
    roleTimeoutMinutes: number;
    /** Минут без сообщений от сессии до диалога вмешательства; 0 — сторож выключен. */
    stallMinutes: number;
    /** Отказов ACL подряд до диалога вмешательства; 0 — проверка выключена. */
    aclDenialStreak: number;
  };
  git: { branchPrefix: string };
  gates: {
    /** Операция → shell-команда проекта, выполняется в worktree. */
    ops: Record<GateOp, string>;
    batch: GateOp[];
    full: GateOp[];
  };
  /** Где acceptance-tester пишет тесты и evidence, и на чём. */
  acceptance: { dir: string; framework: string };
  roles: Record<string, RolePolicy>;
  denyAll: string[];
  /** Файлы, из которых собрана policy: kit и, если есть, целевой репозиторий. */
  sources: string[];
  sha: string;
}

/** Policy kit, поверх неё .agentflow/policy.yaml целевого репозитория (объекты сливаются, списки заменяются). */
export function loadPolicy(repo: string): Policy {
  const files = [join(KIT, '.agentflow/policy.yaml')];
  const own = join(repo, '.agentflow/policy.yaml');
  if (own !== files[0] && existsSync(own)) files.push(own);
  const texts = files.map((f) => readFileSync(f, 'utf8'));
  const p = texts.map((t) => parse(t) ?? {}).reduce((acc, x) => deepMerge(acc, x)) as Omit<Policy, 'sha' | 'sources'>;
  for (const key of ['qwen', 'openspec', 'limits', 'git', 'gates', 'roles', 'acceptance'] as const) {
    if (!p[key]) throw new Error(`policy: нет секции ${key} (${files.join(' + ')})`);
  }
  for (const op of [...p.gates.batch, ...p.gates.full]) {
    if (!p.gates.ops?.[op]) throw new Error(`policy: гейт ${op} не описан в gates.ops`);
  }
  // Policy, собранная до появления ключей (старая копия kit), получает значения по умолчанию.
  p.limits.stallMinutes ??= 15;
  p.limits.aclDenialStreak ??= 5;
  return { ...p, denyAll: p.denyAll ?? [], sources: files, sha: sha256(texts.join('\n---\n')) };
}

/**
 * Окружение сессий ролей и гейтов: agentflow-gate в PATH и команды операций.
 * Роль вызывает `agentflow-gate lint`, скрипт исполняет AGENTFLOW_GATE_LINT.
 */
export function gateEnv(policy: Policy): Record<string, string> {
  const env: Record<string, string> = { PATH: `${KIT_BIN}:${process.env['PATH'] ?? ''}`, AGENTFLOW_KIT: KIT };
  for (const [op, cmd] of Object.entries(policy.gates.ops)) env[`AGENTFLOW_GATE_${op.toUpperCase().replace(/-/g, '_')}`] = cmd;
  return env;
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
