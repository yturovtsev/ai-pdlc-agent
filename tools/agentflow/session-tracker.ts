// Состояние одной сессии роли: текущий шаг и с какого времени он идёт, простой, вложенные
// субагенты CLI, отказы ACL и их серия. Без ввода-вывода и с подставляемыми часами: его
// одинаково кормят runRole (поток SDK) и runMock, а панель, сторож и сводка читают результат.
import type { AclCategory, AclDecision } from './roles.ts';
import { oneLine } from './util.ts';

/** Инструменты, которыми CLI запускает вложенного субагента. */
const NESTED_AGENT_TOOLS = new Set(['task', 'agent']);

export const WAITING_MODEL = 'ждёт ответа модели';

export interface TrackerStep {
  label: string;
  since: number;
}

export interface TrackedDenial {
  tool: string;
  /** Аргумент вызова в той же форме, что строка `→ tool arg`: по нему отказ сопоставляется с permission_denials. */
  arg: string;
  target: string;
  reason: string;
  category: AclCategory;
  hint: string;
  allowed?: string;
}

export interface DenialGroup {
  tool: string;
  target: string;
  reason: string;
  count: number;
  category: AclCategory | 'cli';
  hint: string;
}

export interface DenialSummary {
  total: number;
  groups: DenialGroup[];
}

export interface PermissionDenial {
  tool_name: string;
  tool_input: unknown;
}

/** Аргумент вызова для строки лога и сопоставления отказов. */
export function toolArg(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const v = o['file_path'] ?? o['path'] ?? o['command'] ?? o['pattern'] ?? o['absolute_path'] ?? o['dir_path'];
  return v === undefined ? '' : oneLine(String(v), 100);
}

const CLI_DENIAL_REASON = 'отклонено CLI мимо ACL контроллера';
const CLI_DENIAL_HINT =
  'вызов отклонил сам CLI: правило denyAll или excludeTools из policy либо настройки CLI (.gigacode/settings.json); если вызов нужен роли — проверь эти правила';

export class SessionTracker {
  readonly role: string;
  readonly stallMs: number;
  readonly denialStreak: number;
  readonly denials: TrackedDenial[] = [];
  /** Отказы ACL подряд без единого прошедшего вызова. */
  streak = 0;
  /** Вложенные субагенты CLI, ещё не вернувшие результат. */
  nested = 0;
  private readonly now: () => number;
  private lastEventAt: number;
  /** Последнее «ждать дальше»: порог отсчитывается заново, но простой в диагнозе — от последнего события. */
  private waitedAt = 0;
  private modelSince: number;
  private readonly pending = new Map<string, { label: string; at: number; agent: boolean }>();
  private nestedStep: TrackerStep | undefined;

  constructor(o: { role: string; stallMs: number; denialStreak: number; now?: () => number }) {
    this.role = o.role;
    this.stallMs = o.stallMs;
    this.denialStreak = o.denialStreak;
    this.now = o.now ?? Date.now;
    this.lastEventAt = this.modelSince = this.now();
  }

  /** Любое сообщение сессии, в том числе вложенного субагента. */
  event(): void {
    this.lastEventAt = this.now();
    if (!this.pending.size) this.modelSince = this.lastEventAt;
  }

  /** Вызов инструмента; parent — id вызова вложенного субагента, внутри которого он сделан. */
  toolUse(id: string, name: string, arg: string, parent?: string): void {
    const label = `→ ${name}${arg ? ' ' + arg : ''}`;
    if (parent) {
      this.nestedStep = { label: `вложенный субагент: ${label}`, since: this.now() };
      return;
    }
    const agent = NESTED_AGENT_TOOLS.has(name);
    if (agent) this.nested++;
    this.pending.set(id, { label: agent ? `вложенный субагент ${arg}`.trim() : label, at: this.now(), agent });
  }

  toolResult(id: string, isError: boolean, parent?: string): void {
    if (parent) {
      this.nestedStep = { label: `вложенный субагент: ${WAITING_MODEL}`, since: this.now() };
      return;
    }
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.agent) {
      this.nested = Math.max(0, this.nested - 1);
      if (!this.nested) this.nestedStep = undefined;
    }
    if (!isError) this.streak = 0;
    if (!this.pending.size) this.modelSince = this.now();
  }

  acl(tool: string, input: unknown, d: AclDecision): void {
    if (d.ok) {
      this.streak = 0;
      return;
    }
    this.denials.push({ tool, arg: toolArg(input), target: d.target, reason: d.reason, category: d.category ?? 'expected', hint: d.hint ?? '', allowed: d.allowed });
    this.streak++;
  }

  /** Что сессия делает сейчас: самый ранний незавершённый вызов или ожидание ответа модели. */
  step(): TrackerStep {
    const first = this.pending.values().next().value;
    if (!first) return { label: WAITING_MODEL, since: this.modelSince };
    if (first.agent && this.nestedStep) return this.nestedStep;
    return { label: first.label, since: first.at };
  }

  idleMs(): number {
    return this.now() - this.lastEventAt;
  }

  stalled(): boolean {
    return this.stallMs > 0 && this.now() - Math.max(this.lastEventAt, this.waitedAt) >= this.stallMs;
  }

  streakHit(): boolean {
    return this.denialStreak > 0 && this.streak >= this.denialStreak;
  }

  /** Отказы текущей серии — для диалога и промпта повтора. */
  streakDenials(): TrackedDenial[] {
    return this.denials.slice(this.denials.length - this.streak);
  }

  /** «Ждать дальше»: простой отсчитывается заново. */
  resetIdle(): void {
    this.waitedAt = this.now();
  }

  resetStreak(): void {
    this.streak = 0;
  }

  /**
   * Сводка отказов. permission_denials CLI включает и отказы ACL контроллера: они сопоставляются
   * по (инструмент, аргумент), остальные — отказы самого CLI, которых контроллер не видел.
   */
  summary(permissionDenials: PermissionDenial[] = []): DenialSummary {
    const unmatched = [...this.denials];
    const groups = new Map<string, DenialGroup>();
    const add = (g: Omit<DenialGroup, 'count'>) => {
      const k = JSON.stringify([g.category === 'cli', g.tool, g.target, g.reason]);
      const cur = groups.get(k);
      if (cur) cur.count++;
      else groups.set(k, { ...g, count: 1 });
    };
    for (const d of this.denials) add({ tool: d.tool, target: d.target, reason: d.reason, category: d.category, hint: d.hint });
    for (const p of permissionDenials) {
      const arg = toolArg(p.tool_input);
      const i = unmatched.findIndex((d) => d.tool === p.tool_name && d.arg === arg);
      if (i >= 0) unmatched.splice(i, 1);
      else add({ tool: p.tool_name, target: arg, reason: CLI_DENIAL_REASON, category: 'cli', hint: CLI_DENIAL_HINT });
    }
    const all = [...groups.values()];
    return { total: all.reduce((n, g) => n + g.count, 0), groups: all };
  }
}
