// Роли = файлы .qwen/agents/*.md (единственный источник истины). Контроллер читает их сам
// и превращает в параметры отдельной сессии query() из @qwen-code/sdk.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isSDKAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKUserMessage,
  query,
  type CanUseTool,
  type McpServerConfig,
  type QueryOptions,
  type SDKResultMessage,
} from '@qwen-code/sdk';
import { parse } from 'yaml';
import { c, log } from './log.ts';
import { KIT } from './config.ts';
import { gateEnv, qwenAuthType, qwenExecutable, type Policy } from './policy.ts';
import { interventionError, type Intervention, type InterventionDecision, type InterventionKind, type InterventionOutcome } from './intervention.ts';
import { SessionTracker, toolArg } from './session-tracker.ts';
import { matchesAny, oneLine, sha256 } from './util.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RoleDef {
  name: string;
  description: string;
  model: string;
  effort?: Effort;
  tools: string[];
  maxTurns?: number;
  prompt: string;
  file: string;
  sha: string;
}

export const READ_TOOLS = ['read_file', 'grep_search', 'glob', 'list_directory'];
const WRITE_TOOLS = new Set(['write_file', 'edit', 'notebook_edit']);
const SHELL_TOOLS = new Set(['run_shell_command']);
const MCP_PREFIX = 'mcp__';

/** Роли kit (.qwen/agents/), поверх них одноимённые файлы целевого репозитория (.agentflow/agents/). */
export function roleFiles(repo: string): { file: string; path: string }[] {
  const kitDir = join(KIT, '.qwen/agents');
  const ownDir = join(repo, '.agentflow/agents');
  const names = new Set([...readdirSync(kitDir), ...(existsSync(ownDir) ? readdirSync(ownDir) : [])].filter((f) => f.endsWith('.md')));
  return [...names].sort().map((file) => {
    const own = join(ownDir, file);
    return { file, path: existsSync(own) ? own : join(kitDir, file) };
  });
}

export function loadRoles(repo: string): Map<string, RoleDef> {
  const roles = new Map<string, RoleDef>();
  for (const { file, path } of roleFiles(repo)) {
    const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) throw new Error(`${file}: нет YAML frontmatter`);
    const fm = parse(m[1]!) as Record<string, unknown>;
    const name = String(fm['name'] ?? '');
    if (!name || !fm['model']) throw new Error(`${file}: обязательны name и model`);
    // Селектор "authType:model" из qwen-code тоже допустим; в SDK уходит только id.
    const model = String(fm['model']).replace(/^(openai|anthropic|gemini|vertex-ai|qwen-oauth):/, '');
    roles.set(name, {
      name,
      description: String(fm['description'] ?? ''),
      model,
      effort: fm['effort'] as Effort | undefined,
      tools: Array.isArray(fm['tools']) ? (fm['tools'] as string[]) : String(fm['tools'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      maxTurns: typeof fm['maxTurns'] === 'number' ? fm['maxTurns'] : undefined,
      prompt: m[2]!.trim(),
      file: path.startsWith(KIT + '/') ? `kit:${path.slice(KIT.length + 1)}` : path.slice(repo.length + 1),
      sha: sha256(text),
    });
  }
  return roles;
}

/** Метаданные шага: настоящей модели не нужны, по ним работает mock-раннер. */
export interface TaskMeta {
  kind: 'clarify' | 'discuss' | 'author' | 'spec-review' | 'holistic' | 'implement' | 'code-review' | 'acceptance' | 'final-review';
  artifact?: string;
  generates?: string;
  changeDir?: string;
  snapshotId?: string;
  round?: number;
  checks?: string[];
  target?: string;
  batchId?: string;
  requirements?: { id: string; name: string; scenarios: { id: string; name: string }[] }[];
  /** Обсуждение вопроса: id и текущие варианты — по ним отвечает mock-роль. */
  discuss?: { id: string; options: { label: string; description?: string }[]; recommended: number };
  /** Fault injection stall:<роль>: mock-сессия молчит до прерывания. */
  silent?: boolean;
  /** Fault injection think-long:<роль>: mock-сессия 30 с присылает размышления раз в секунду. */
  thinkLong?: boolean;
}

/** Над чем работает вызов — для панели статуса и события spawn. */
export function describeTask(meta: TaskMeta): string {
  switch (meta.kind) {
    case 'clarify':
      return 'уточнение intent';
    case 'discuss':
      return `обсуждение вопроса ${meta.discuss?.id ?? ''}`.trim();
    case 'author':
      return `пишет ${meta.generates ?? meta.artifact ?? 'артефакт'}`;
    case 'spec-review':
      return `ревью ${meta.artifact ?? meta.target ?? 'артефакта'}`;
    case 'holistic':
      return 'сквозное ревью change';
    case 'implement':
      // Находки финального ревью implementer закрывает в синтетическом батче final-<раунд>.
      return meta.batchId?.startsWith('final-') ? `исправления финального ревью, раунд ${meta.batchId.slice(6)}` : `батч ${meta.batchId ?? '?'}`;
    case 'code-review':
      return `ревью батча ${meta.batchId ?? '?'}`;
    case 'acceptance':
      return 'acceptance-тесты';
    case 'final-review':
      return 'финальное ревью';
  }
}

export interface RoleCall {
  role: RoleDef;
  prompt: string;
  /** Метка шага для лога и events.jsonl. */
  label: string;
  cwd: string;
  /** Только инструменты чтения, запись и shell недоступны (шаг уточнений). */
  readOnly?: boolean;
  /** Продолжить сессию (раунд исправлений implementer). */
  resume?: string;
  meta: TaskMeta;
  /**
   * Решение о вмешательстве при простое или серии отказов ACL; диагноз в лог пишет оно же (строкой
   * контекста диалога). signal прерывается, если сессия ожила.
   */
  intervene?: (ev: Intervention, signal: AbortSignal) => Promise<InterventionDecision>;
}

export interface RoleResult {
  ok: boolean;
  sessionId: string;
  text: string;
  error?: string;
  turns: number;
  seconds: number;
  models: string[];
  denials: number;
  usage?: { input_tokens: number; output_tokens: number };
  /** MCP-инструменты, которые выполнились (успешный tool_result), — для сверки с policy после роли. */
  mcpCalls?: string[];
  /** Сессия прервана по решению о вмешательстве (повтор или стоп). */
  intervention?: InterventionOutcome;
}

export interface RoleRuntime {
  policy: Policy;
  change: string;
  worktree: string;
  /** Каталог контекст-пакетов прогона: доступен ролям на чтение. */
  contextsDir: string;
  ledger: (event: Record<string, unknown>) => void;
  mock?: (rt: RoleRuntime, call: RoleCall) => Promise<RoleResult>;
  /** MCP-серверы, переданные сессии через SDK (smoke); обычно серверы берутся из настроек CLI. */
  mcpServers?: Record<string, McpServerConfig>;
}

/** Отказ ACL: ожидаемый (роль обойдётся сама) или признак, что роли не хватает разрешения в policy. */
export type AclCategory = 'expected' | 'permission';

export interface AclDecision {
  ok: boolean;
  target: string;
  reason: string;
  /** Только у отказа. */
  category?: AclCategory;
  /** Что делать человеку: действий не нужно или какой ключ policy поправить. */
  hint?: string;
  /** Что роли разрешено в этой категории — уходит модели, чтобы она не повторяла вызов. */
  allowed?: string;
}

/** Подстановки в glob policy: {change} — id change, {acceptance} — каталог acceptance-тестов. */
export function expandGlob(glob: string, change: string, policy: Policy): string {
  return glob.replaceAll('{change}', change).replaceAll('{acceptance}', policy.acceptance.dir.replace(/\/$/, ''));
}

const NO_ACTION = 'действий не нужно';

/** Решение ACL роли по вызову инструмента. Всё, что не разрешено явно, отклоняется. */
export function decideAcl(rt: RoleRuntime, roleName: string, readOnly: boolean, toolName: string, input: Record<string, unknown>): AclDecision {
  const rp = rt.policy.roles[roleName] ?? { write: [], shell: [] };
  const sub = (g: string) => expandGlob(g, rt.change, rt.policy);
  const key = `roles.${roleName}`;
  const deny = (target: string, reason: string, category: AclCategory, hint: string, allowed: string): AclDecision => ({ ok: false, target, reason, category, hint, allowed });
  const readOnlyAllowed = `шаг только на чтение: ${READ_TOOLS.join(', ')}`;
  const writeAllowed = rp.write.length
    ? `запись по glob ${rp.write.map(sub).join(', ')}${rp.denyWrite?.length ? ` кроме ${rp.denyWrite.map(sub).join(', ')}` : ''}`
    : 'запись роли не разрешена';
  const gates = rp.shell.map((op) => `agentflow-gate ${op}`);
  const shellAllowed = gates.length ? `shell — только ${gates.join(', ')}` : 'shell-команды роли не разрешены';
  if (WRITE_TOOLS.has(toolName)) {
    const raw = String(input['file_path'] ?? input['path'] ?? input['absolute_path'] ?? '');
    const abs = isAbsolute(raw) ? raw : resolve(rt.worktree, raw);
    const rel = relative(rt.worktree, abs).split(sep).join('/');
    if (!raw) return deny('(нет пути)', 'не указан путь', 'expected', `роль не указала путь — ${NO_ACTION}`, writeAllowed);
    if (rel.startsWith('..') || isAbsolute(rel)) return deny(raw, 'вне worktree', 'expected', `роль ошиблась путём — ${NO_ACTION}`, `${writeAllowed} внутри worktree`);
    if (readOnly) return deny(rel, 'шаг только на чтение', 'expected', `шаг уточнений только читает — ${NO_ACTION}`, readOnlyAllowed);
    if (!matchesAny(rel, rp.write.map(sub))) {
      return deny(rel, `роли ${roleName} запись сюда не разрешена`, 'permission', `если роли нужен этот путь — добавь glob для ${rel} в ${key}.write (.agentflow/policy.yaml)`, writeAllowed);
    }
    const guard = (rp.denyWrite ?? []).find((g) => matchesAny(rel, [sub(g)]));
    if (guard) {
      return deny(rel, 'защищённый путь', 'expected', `путь защищён шаблоном ${guard} из ${key}.denyWrite — роль должна обойтись; если путь ей правда нужен, убери шаблон из denyWrite`, writeAllowed);
    }
    return { ok: true, target: rel, reason: 'разрешено policy' };
  }
  if (SHELL_TOOLS.has(toolName)) {
    const cmd = String(input['command'] ?? '').trim();
    const m = cmd.match(/^agentflow-gate\s+([a-z0-9-]+)$/);
    if (!m) {
      return deny(cmd, 'разрешена только команда agentflow-gate <операция>', 'expected', `роль должна вызывать agentflow-gate; если нужна другая команда — оформи её операцией в gates.ops и добавь в ${key}.shell`, shellAllowed);
    }
    const op = m[1]!;
    if (readOnly) return deny(cmd, 'шаг только на чтение', 'expected', `шаг уточнений только читает — ${NO_ACTION}`, readOnlyAllowed);
    if (!rt.policy.gates.ops[op]) return deny(cmd, `операции ${op} нет в gates.ops`, 'expected', `такой операции нет — ${NO_ACTION}; роли доступны: ${gates.join(', ') || 'ничего'}`, shellAllowed);
    if (!rp.shell.includes(op)) return deny(cmd, `операция ${op} роли не разрешена`, 'permission', `если роли нужна операция ${op} — добавь её в ${key}.shell`, shellAllowed);
    return { ok: true, target: cmd, reason: 'операция gates.ops из policy' };
  }
  if (toolName.startsWith(MCP_PREFIX)) {
    const mcpAllowed = rp.mcp?.length ? `MCP по шаблонам ${rp.mcp.join(', ')}` : 'MCP-инструменты роли не разрешены';
    if (readOnly) return deny(toolName, 'шаг только на чтение', 'expected', `шаг уточнений только читает — ${NO_ACTION}`, readOnlyAllowed);
    const hit = (rp.mcp ?? []).find((g) => matchesAny(toolName, [g]));
    return hit
      ? { ok: true, target: toolName, reason: `шаблон ${hit} из ${key}.mcp` }
      : deny(toolName, `нет в ${key}.mcp`, 'permission', `если роли нужен этот инструмент — добавь шаблон ${toolName} в ${key}.mcp`, mcpAllowed);
  }
  // ask_user_question и прочее, что CLI отправляет на разрешение: ролям не выдаётся намеренно.
  const why = toolName === 'ask_user_question' ? ' (вопросы человеку идут через шаг уточнений)' : '';
  return deny(toolName, 'инструмент не в политике роли', 'expected', `инструмент ${toolName} ролям не выдаётся${why} — ${NO_ACTION}`, readOnly ? readOnlyAllowed : `чтение, ${writeAllowed}, ${shellAllowed}`);
}

/** Ответ модели на отказ: причина, что разрешено и просьба не повторять — иначе модель пробует обойти запрет. */
export function aclDenyMessage(d: AclDecision): string {
  return `agentflow ACL: ${d.reason}. Разрешено: ${d.allowed ?? 'см. политику роли'}. Не повторяй этот вызов — обойдись разрешённым.`;
}

export function aclFor(rt: RoleRuntime, roleName: string, readOnly: boolean, onDecision?: (tool: string, input: Record<string, unknown>, d: AclDecision) => void): CanUseTool {
  return async (toolName, input) => {
    const d = decideAcl(rt, roleName, readOnly, toolName, input);
    log.acl(roleName, toolName, d);
    onDecision?.(toolName, input, d);
    return d.ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: aclDenyMessage(d) };
  };
}

export function toolsFor(role: RoleDef, readOnly?: boolean): string[] {
  return readOnly ? role.tools.filter((t) => READ_TOOLS.includes(t)) : role.tools;
}

/** MCP-шаблоны роли в этом шаге: в шаге только на чтение MCP нет ни у кого. */
export function mcpPatterns(policy: Policy, roleName: string, readOnly?: boolean): string[] {
  return readOnly ? [] : (policy.roles[roleName]?.mcp ?? []);
}

export interface SessionTools {
  coreTools: string[];
  excludeTools: string[];
  allowedMcpServerNames?: string[];
}

/**
 * Инструменты сессии. coreTools CLI фильтрует только встроенные инструменты, а MCP-вызов с
 * readOnlyHint или с сервера trust: true выполняется без canUseTool. Поэтому роль без MCP
 * получает deny-правило mcp__*: CLI проверяет его раньше разрешения по умолчанию.
 */
export function sessionTools(policy: Policy, role: RoleDef, readOnly?: boolean): SessionTools {
  const mcp = mcpPatterns(policy, role.name, readOnly);
  const coreTools = toolsFor(role, readOnly).filter((t) => !t.startsWith(MCP_PREFIX));
  if (!mcp.length) return { coreTools, excludeTools: [...policy.denyAll, `${MCP_PREFIX}*`] };
  const servers = mcp.map((g) => {
    const parts = g.split('__');
    return parts.length >= 3 && parts[0] === 'mcp' && parts[1] && !/[*?]/.test(parts[1]) ? parts[1] : undefined;
  });
  const named = servers.every((x): x is string => !!x);
  return { coreTools, excludeTools: policy.denyAll, ...(named ? { allowedMcpServerNames: [...new Set(servers)] } : {}) };
}

/** Инструменты для лога запуска: встроенные из coreTools и MCP-шаблоны роли в этом шаге. */
export function spawnTools(policy: Policy, role: RoleDef, readOnly?: boolean): string[] {
  return [...sessionTools(policy, role, readOnly).coreTools, ...mcpPatterns(policy, role.name, readOnly)];
}

/** MCP-вызовы роли вне её шаблонов: CLI мог выполнить их без ACL (trust, readOnlyHint). */
export function mcpViolations(policy: Policy, roleName: string, readOnly: boolean | undefined, calls: string[]): string[] {
  const mcp = mcpPatterns(policy, roleName, readOnly);
  return [...new Set(calls.filter((t) => t.startsWith(MCP_PREFIX) && !matchesAny(t, mcp)))];
}

/** MCP-инструменты из tools: роли, которые policy не разрешает: CLI на tools: для MCP не смотрит. */
export function mcpWarnings(policy: Policy, roles: Map<string, RoleDef>): string[] {
  const out: string[] = [];
  for (const r of roles.values()) {
    const missing = r.tools.filter((t) => t.startsWith(MCP_PREFIX) && !matchesAny(t, policy.roles[r.name]?.mcp ?? []));
    if (missing.length) out.push(`${r.name}: ${missing.join(', ')} в tools: (${r.file}) не разрешены policy — добавь шаблон в roles.${r.name}.mcp`);
  }
  return out;
}

/** Порог простоя сессии: под --mock — 2 с, чтобы точка stall:<роль> проходилась за секунды. */
export function stallMs(rt: RoleRuntime): number {
  return rt.mock ? 2000 : rt.policy.limits.stallMinutes * 60_000;
}

export function newTracker(rt: RoleRuntime, role: string): SessionTracker {
  return new SessionTracker({ role, stallMs: stallMs(rt), denialStreak: rt.policy.limits.aclDenialStreak });
}

/** Шаг, вложенные и отказы сессии — в панель статуса. */
export function syncPanel(t: SessionTracker): void {
  const last = t.denials.at(-1);
  log.session({ step: t.step(), nested: t.nested, denials: t.denials.length, lastDenial: last && `${last.tool} ${oneLine(last.target, 40)} — ${last.reason}` });
}

/**
 * Сторож сессии: раз в секунду смотрит на простой и серию отказов и, если порог пройден,
 * спрашивает call.intervene. Повтор и стоп прерывают сессию через её abortController;
 * решение исполняет вызывающий по outcome.
 */
export class Watchdog {
  outcome: InterventionOutcome | undefined;
  private dialog: { kind: InterventionKind; ctl: AbortController } | undefined;
  private pending: Promise<void> | undefined;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly rt: RoleRuntime,
    private readonly call: RoleCall,
    private readonly tracker: SessionTracker,
    private readonly abort: AbortController,
  ) {
    this.timer = setInterval(() => this.check(), 1000);
    this.timer.unref();
  }

  /**
   * Новое сообщение сессии. Диалог простоя закрывается: сессия ожила. Диалог серии ACL — нет:
   * роль, упёршаяся в ACL, продолжает присылать отказы, и диалог закрывался бы сразу.
   */
  activity(): void {
    if (this.dialog?.kind === 'stall') this.dialog.ctl.abort();
  }

  /** Сессия закончилась: открытый диалог закрывается, поздние решения уже не действуют. */
  async stop(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.dialog?.ctl.abort();
    await this.pending;
  }

  check(): void {
    if (this.closed || this.pending || this.outcome || !this.call.intervene) return;
    const kind = this.tracker.stalled() ? 'stall' : this.tracker.streakHit() ? 'acl-streak' : undefined;
    if (!kind) return;
    this.pending = this.intervene(kind).finally(() => (this.pending = undefined));
  }

  private async intervene(kind: InterventionKind): Promise<void> {
    const t = this.tracker;
    const ev: Intervention = { kind, role: t.role, step: t.step(), idleMs: t.idleMs(), denials: kind === 'acl-streak' ? t.streakDenials() : [] };
    this.rt.ledger({
      ev: kind,
      role: ev.role,
      step: ev.step.label,
      since: new Date(ev.step.since).toISOString(),
      idleMs: ev.idleMs,
      ...(ev.denials.length ? { denials: ev.denials.map((d) => ({ tool: d.tool, target: d.target, reason: d.reason, category: d.category })) } : {}),
    });
    const ctl = new AbortController();
    this.dialog = { kind, ctl };
    let decision: InterventionDecision;
    try {
      decision = await this.call.intervene!(ev, ctl.signal);
    } finally {
      this.dialog = undefined;
    }
    this.rt.ledger({ ev: 'intervention', role: ev.role, kind, decision });
    if (this.closed) return;
    if (decision === 'retry' || decision === 'stop') {
      this.outcome = { kind, decision, denials: ev.denials, message: interventionError(ev) };
      this.abort.abort();
    } else if (kind === 'stall') t.resetIdle();
    else t.resetStreak();
  }
}

/**
 * В stream-json CLI не завершает сессию ошибкой при сбое API (таймаут, обрыв, 4xx/5xx): он дописывает
 * «[API Error: …]» текстом ассистента и отдаёт успешный result. Это сбой шага, а не ответ роли.
 */
export function apiErrorIn(text: string): string | undefined {
  const i = text.lastIndexOf('[API Error:');
  return i < 0 ? undefined : text.slice(i);
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join(' ');
  return '';
}

export async function runRole(rt: RoleRuntime, call: RoleCall): Promise<RoleResult> {
  if (rt.mock) return rt.mock(rt, call);
  const { role } = call;
  const sessionId = call.resume ?? randomUUID();
  const tools = spawnTools(rt.policy, role, call.readOnly);
  const effort = rt.policy.qwen.effortViaSdk ? role.effort : undefined;
  log.spawn(role.name, { model: role.model, effort, session: sessionId, resume: !!call.resume, tools, target: describeTask(call.meta) });
  let answered = false;
  try {
    const res = await runSession(rt, call, sessionId, effort);
    answered = !res.intervention && (res.ok || res.turns > 0);
    return res;
  } finally {
    log.roleEnd(role.name, answered);
  }
}

async function runSession(rt: RoleRuntime, call: RoleCall, sessionId: string, effort: Effort | undefined): Promise<RoleResult> {
  const { role } = call;
  const st = sessionTools(rt.policy, role, call.readOnly);
  const tracker = newTracker(rt, role.name);
  const abortController = new AbortController();
  const minutes = rt.policy.limits.roleTimeoutMinutes;
  const timer = minutes > 0 ? setTimeout(() => abortController.abort(), minutes * 60_000) : undefined;
  const exe = qwenExecutable(rt.policy);
  const authType = qwenAuthType(rt.policy);
  const apiTimeout = rt.policy.qwen.apiTimeoutSeconds ?? 0;
  // SDK 0.1.8 пересылает stderr CLI в callback только на уровне debug: без этого причина
  // падения CLI ("exited with code 1") теряется. Хвост держим для сообщения об ошибке.
  const stderrTail: string[] = [];
  let spawnLine = '';
  const onStderr = (text: string) => {
    rt.ledger({ ev: 'stderr', role: role.name, text });
    if (text.includes('Spawning CLI')) spawnLine = text.slice(text.indexOf('Spawning CLI'));
    else if (!/\[(Query|SdkControl|McpTransport)\]|Writing to stdin|Write successful|started successfully/.test(text)) {
      stderrTail.push(oneLine(text, 400));
      if (stderrTail.length > 12) stderrTail.shift();
    }
  };
  const options: QueryOptions = {
    cwd: call.cwd,
    model: role.model,
    systemPrompt: { type: 'preset', preset: 'qwen_code', append: role.prompt },
    permissionMode: 'default',
    coreTools: st.coreTools,
    excludeTools: st.excludeTools,
    ...(st.allowedMcpServerNames ? { allowedMcpServerNames: st.allowedMcpServerNames } : {}),
    ...(rt.mcpServers ? { mcpServers: rt.mcpServers } : {}),
    canUseTool: aclFor(rt, role.name, !!call.readOnly, (tool, input, d) => {
      tracker.acl(tool, input, d);
      syncPanel(tracker);
    }),
    maxSessionTurns: role.maxTurns,
    includeDirectories: [rt.contextsDir],
    abortController,
    debug: rt.policy.qwen.debug,
    logLevel: 'debug',
    stderr: onStderr,
    env: { ...gateEnv(rt.policy), ...(apiTimeout ? { QWEN_CODE_API_TIMEOUT_MS: String(apiTimeout * 1000) } : {}) },
    ...(call.resume ? { resume: call.resume } : { sessionId }),
    ...(effort ? { effort } : {}),
    ...(exe ? { pathToQwenExecutable: exe } : {}),
    ...(authType ? { authType } : {}),
  };

  const started = Date.now();
  const models = new Set<string>();
  // Отклонённый CLI или ACL вызов приходит с is_error: в сверку идут только выполненные.
  const mcpUses = new Map<string, string>();
  const mcpCalls: string[] = [];
  let result: SDKResultMessage | undefined;
  let error: string | undefined;
  const watch = new Watchdog(rt, call, tracker, abortController);
  try {
    const q = query({ prompt: call.prompt, options });
    for await (const m of q) {
      rt.ledger({ ev: 'sdk', step: call.label, role: role.name, msg: m });
      tracker.event();
      watch.activity();
      // Сообщения вложенного субагента CLI приходят в том же потоке с id его вызова task/agent.
      const parent = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
      if (isSDKSystemMessage(m) && m.subtype === 'init') {
        const mcpTools = (m.tools ?? []).filter((t) => t.startsWith(MCP_PREFIX)).length;
        const servers = (m.mcp_servers ?? []).map((x) => `${x.name} ${x.status}`).join(', ');
        log.role(
          role.name,
          c.gray(`сессия открыта · модель ${m.model ?? '?'} · режим ${m.permission_mode ?? '?'} · инструментов ${m.tools?.length ?? 0}`) +
            (servers || mcpTools ? c.gray(` · MCP: ${servers || 'серверов нет'}, инструментов ${mcpTools}`) : ''),
        );
      } else if (isSDKAssistantMessage(m)) {
        if (m.message.model) models.add(m.message.model);
        for (const b of m.message.content) {
          if (b.type === 'text' && b.text.trim()) log.role(role.name, '«' + oneLine(b.text, 220) + '»');
          else if (b.type === 'thinking') log.thinking(role.name, b.thinking);
          else if (b.type === 'tool_use') {
            if (b.name.startsWith(MCP_PREFIX)) mcpUses.set(b.id, b.name);
            tracker.toolUse(b.id, b.name, toolArg(b.input), parent);
            log.toolUse(role.name, b.name, toolArg(b.input));
          }
        }
      } else if (isSDKUserMessage(m) && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type !== 'tool_result') continue;
          tracker.toolResult(b.tool_use_id, !!b.is_error, parent);
          if (b.is_error) log.role(role.name, c.red('✗ ' + oneLine(blockText(b.content), 160)));
          else if (mcpUses.has(b.tool_use_id)) mcpCalls.push(mcpUses.get(b.tool_use_id)!);
        }
      } else if (isSDKResultMessage(m)) {
        result = m;
      }
      syncPanel(tracker);
    }
  } catch (e) {
    error = watch.outcome?.message ?? (abortController.signal.aborted ? `таймаут роли ${minutes} мин` : e instanceof Error ? e.message : String(e));
  } finally {
    if (timer) clearTimeout(timer);
    await watch.stop();
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const base = { sessionId, seconds, models: [...models], mcpCalls };
  const denials = tracker.summary(result?.permission_denials ?? []);
  if (watch.outcome) {
    // Сессию прервал человек (или автопилот): stderr CLI тут не причина, только шум.
    log.denials(role.name, denials.groups);
    return { ...base, ok: false, text: '', error: watch.outcome.message, turns: result?.num_turns ?? 0, denials: denials.total, intervention: watch.outcome };
  }
  if (!result) {
    log.denials(role.name, denials.groups);
    // CLI упал до ответа: показываем его stderr и команду запуска, чтобы причину было видно сразу.
    log.error(`${role.name}: CLI завершился без ответа: ${error ?? 'нет result'}`);
    if (spawnLine) log.info(c.gray(`  команда: ${oneLine(spawnLine, 600)}`));
    for (const l of stderrTail) log.info(c.gray(`  stderr: ${l}`));
    const tail = stderrTail.slice(-3).join(' | ');
    return { ...base, ok: false, text: '', error: `${error ?? 'сессия завершилась без result'}${tail ? ` — stderr: ${tail}` : ''}`, turns: 0, denials: denials.total };
  }
  const info = {
    turns: result.num_turns,
    denials: denials.total,
    usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
  };
  log.roleDone(role.name, { turns: info.turns, seconds, models: base.models, denials: info.denials, groups: denials.groups });
  if (result.is_error) {
    return { ...base, ...info, ok: false, text: '', error: `${result.subtype}${result.error?.message ? ': ' + result.error.message : ''}` };
  }
  const text = result.result;
  const apiError = apiErrorIn(text);
  if (apiError) return { ...base, ...info, ok: false, text: '', error: `ошибка API: ${oneLine(apiError, 300)}` };
  if (!text.trim()) return { ...base, ...info, ok: false, text, error: 'пустой ответ' };
  return { ...base, ...info, ok: true, text };
}
