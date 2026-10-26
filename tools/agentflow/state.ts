// state.json — единственный источник правды о прогоне: текущий шаг, snapshot входов,
// findings, гейты, фактические модели, решения человека, причина остановки.
// Запись атомарная (временный файл + rename), каждый этап идемпотентен.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now } from './util.ts';

export type Severity = 'critical' | 'major' | 'minor' | 'nit';
export type FindingStatus = 'open' | 'fixed' | 'disputed' | 'closed' | 'logged' | 'waived';

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
  /** Снято человеком с причиной; действует только на этом snapshot. */
  waiver?: { reason: string; at: string; snapshot: string };
}

export interface QuestionOption {
  label: string;
  description?: string;
}

/** Реплика обсуждения вопроса или решения: текст человека и ответ роли. */
export interface DiscussTurn {
  at: string;
  message: string;
  answer: string;
  /** Кто ответил — в обсуждении решения собеседников бывает двое. */
  role?: string;
  /** Роль заменила варианты или рекомендацию в этой реплике. */
  optionsChanged?: boolean;
}

/** Уточнение intent: вопрос шага уточнений, ответ человека и переписка обсуждения. */
export interface Clarification {
  question: string;
  answer: string;
  discussion?: DiscussTurn[];
}

export interface Question {
  id: string;
  question: string;
  why?: string;
  options?: QuestionOption[];
  /** Индекс рекомендуемого варианта и обоснование — от автора вопроса. */
  recommended?: number;
  rationale?: string;
  artifact: string;
  from: string;
  answer?: string;
  discussion?: DiscussTurn[];
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
  /** Принят решением человека «Всё равно перейти дальше», без PASS ревьюера. */
  passedBy?: 'human';
}

export interface BatchState {
  id: string;
  title: string;
  /** file/line — место задачи в файле задач схемы (из openspec instructions apply). */
  tasks: { id: string; text: string; done: boolean; file?: string; line?: number }[];
  status: 'pending' | 'done';
  rounds: number;
  base?: string;
  head?: string;
  /** Закрыт решением человека «Всё равно перейти дальше»: задачи не отмечаются. */
  passedBy?: 'human';
}

/** Петля, пройденная решением человека «Всё равно перейти дальше». */
export interface Proceeded {
  at: string;
  loop: string;
  label: string;
  reason: string;
  /** Id находок, снятых вместе с переходом. */
  findings: string[];
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
  /** skip — роли, выключенные в настройках run: их шаги пропускаются. */
  options: { autoApprove: boolean; mock: boolean; clarify: boolean; inject: string[]; skip: string[] };
  versions: { prompts: string; policy: string; sdk: string; openspec: string; openspecBin?: string };
  stagesDone: Stage[];
  intent: { source: string; text: string; clarifications: Clarification[] };
  spec: {
    order: string[];
    /** Схема OpenSpec change (из .openspec.yaml change или config.yaml репозитория). */
    schema?: string;
    artifacts: Record<string, ArtifactState>;
    holisticPassed: boolean;
    /** Digest пакета, на котором сквозное ревью дало PASS. */
    holisticDigest?: string;
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
  /** Переходы дальше решением человека. */
  proceeded: Proceeded[];
  /** Переписка обсуждения диалогов решений: ключ — гейт и номер показа («exhausted:batch 2#1»). */
  dialogs: Record<string, DiscussTurn[]>;
  injected: string[];
  /** Счётчики повторяющихся точек fault injection (…-stuck). */
  injectCounts?: Record<string, number>;
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
    // state.json прогонов до перехода дальше и обсуждения решений.
    this.state.proceeded ??= [];
    this.state.dialogs ??= {};
    this.state.options.skip ??= [];
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
