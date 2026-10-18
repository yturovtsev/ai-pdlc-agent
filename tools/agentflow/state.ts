// state.json — единственный источник правды о прогоне: текущий шаг, snapshot входов,
// findings, гейты, фактические модели, решения человека, причина остановки.
// Запись атомарная (временный файл + rename), каждый этап идемпотентен.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now } from './util.ts';

export type Severity = 'critical' | 'major' | 'minor' | 'nit';
export type FindingStatus = 'open' | 'fixed' | 'disputed' | 'closed' | 'logged';

export interface Finding {
  id: string;
  severity: Severity;
  location: string;
  problem: string;
  evidence: string;
  requirementId?: string | null;
  artifact?: string | null;
  category?: string;
  requiredChange?: string;
  verification?: string;
  needsHuman?: boolean;
  /** Кто нашёл: роль, validator, gate, human, inject. */
  source: string;
  step: string;
  round: number;
  status: FindingStatus;
  response?: { resolution: 'fixed' | 'disputed'; evidence: string };
}

export interface Question {
  id: string;
  question: string;
  why?: string;
  options?: string[];
  artifact: string;
  from: string;
  answer?: string;
}

export interface LoopEntry {
  loop: string;
  round: number;
  verdict: string;
  note?: string;
  at: string;
}

export interface GateRecord {
  op: string;
  ok: boolean;
  exitCode: number;
  step: string;
  logPath: string;
  at: string;
}

export interface ArtifactState {
  status: 'pending' | 'accepted';
  rounds: number;
  snapshot?: string;
  authorSession?: string;
}

export interface BatchState {
  id: string;
  title: string;
  tasks: { id: string; text: string; done: boolean }[];
  status: 'pending' | 'done';
  rounds: number;
  base?: string;
  head?: string;
}

export type Stage =
  | 'clarify'
  | 'spec'
  | 'approval'
  | 'freeze'
  | 'apply'
  | 'acceptance'
  | 'final'
  | 'report'
  | 'human-acceptance'
  | 'archive';

export const STAGES: Stage[] = [
  'clarify',
  'spec',
  'approval',
  'freeze',
  'apply',
  'acceptance',
  'final',
  'report',
  'human-acceptance',
  'archive',
];

export interface RunState {
  runId: string;
  change: string;
  status: 'running' | 'blocked' | 'accepted' | 'rejected' | 'failed';
  stage: Stage;
  step: string;
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
  repoRoot: string;
  worktree: string;
  branch: string;
  baseCommit: string;
  options: { autoApprove: boolean; mock: boolean; clarify: boolean; inject: string[] };
  versions: { prompts: string; policy: string; sdk: string; openspec: string };
  stagesDone: Stage[];
  intent: { source: string; text: string; clarifications: { question: string; answer: string }[] };
  spec: {
    order: string[];
    artifacts: Record<string, ArtifactState>;
    holisticPassed: boolean;
    questions: Question[];
    freeze?: { digest: string; at: string; commit: string };
  };
  apply: { base?: string; batches: BatchState[] };
  acceptance?: { status: string; snapshot: string; report: unknown };
  final?: { status: string; snapshot: string; rounds: number; traceability: unknown[] };
  findings: Finding[];
  gates: GateRecord[];
  loops: LoopEntry[];
  /** Фактические модели из ответов API по ролям. */
  models: Record<string, { requested: string; effort?: string; actual: string[] }>;
  usage: Record<string, { calls: number; turns: number; inputTokens: number; outputTokens: number; seconds: number }>;
  decisions: { at: string; gate: string; decision: string; comment?: string }[];
  injected: string[];
}

export class RunStore {
  readonly statePath: string;
  readonly ledgerPath: string;
  state!: RunState;

  constructor(readonly runDir: string) {
    this.statePath = join(runDir, 'state.json');
    this.ledgerPath = join(runDir, 'events.jsonl');
  }

  exists(): boolean {
    return existsSync(this.statePath);
  }

  load(): RunState {
    this.state = JSON.parse(readFileSync(this.statePath, 'utf8')) as RunState;
    return this.state;
  }

  save(): void {
    this.state.updatedAt = now();
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.statePath);
  }

  /** Шаг для лога и resume: «spec:artifact:proposal:review». */
  setStep(step: string): void {
    this.state.step = step;
    this.save();
    this.append({ ev: 'step-start', step });
  }

  loop(loop: string, round: number, verdict: string, note?: string): void {
    this.state.loops.push({ loop, round, verdict, note, at: now() });
    this.save();
  }

  append(event: Record<string, unknown>): void {
    appendFileSync(this.ledgerPath, JSON.stringify({ at: now(), ...event }) + '\n');
  }
}
