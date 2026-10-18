// Роли = файлы .qwen/agents/*.md (единственный источник истины). Контроллер читает их сам
// и превращает в параметры отдельной сессии query() из @qwen-code/sdk.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isSDKAssistantMessage,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKUserMessage,
  query,
  type CanUseTool,
  type QueryOptions,
  type SDKResultMessage,
} from '@qwen-code/sdk';
import { parse } from 'yaml';
import { c, log } from './log.ts';
import { qwenAuthType, qwenExecutable, type Policy } from './policy.ts';
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

export function loadRoles(repoRoot: string): Map<string, RoleDef> {
  const dir = join(repoRoot, '.qwen/agents');
  const roles = new Map<string, RoleDef>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
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
      file: `.qwen/agents/${file}`,
      sha: sha256(text),
    });
  }
  return roles;
}

/** Метаданные шага: настоящей модели не нужны, по ним работает mock-раннер. */
export interface TaskMeta {
  kind: 'clarify' | 'author' | 'spec-review' | 'holistic' | 'implement' | 'code-review' | 'acceptance' | 'final-review';
  artifact?: string;
  generates?: string;
  changeDir?: string;
  snapshotId?: string;
  round?: number;
  checks?: string[];
  target?: string;
  batchId?: string;
  requirements?: { id: string; name: string; scenarios: { id: string; name: string }[] }[];
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
}

export interface RoleRuntime {
  policy: Policy;
  change: string;
  worktree: string;
  /** Каталог контекст-пакетов прогона: доступен ролям на чтение. */
  contextsDir: string;
  ledger: (event: Record<string, unknown>) => void;
  mock?: (rt: RoleRuntime, call: RoleCall) => Promise<RoleResult>;
}

export interface AclDecision {
  ok: boolean;
  target: string;
  reason: string;
}

/** Решение ACL роли по вызову инструмента. Всё, что не разрешено явно, отклоняется. */
export function decideAcl(rt: RoleRuntime, roleName: string, readOnly: boolean, toolName: string, input: Record<string, unknown>): AclDecision {
  const rp = rt.policy.roles[roleName] ?? { write: [], shell: [] };
  const sub = (g: string) => g.replaceAll('{change}', rt.change);
  if (WRITE_TOOLS.has(toolName)) {
    const raw = String(input['file_path'] ?? input['path'] ?? input['absolute_path'] ?? '');
    const abs = isAbsolute(raw) ? raw : resolve(rt.worktree, raw);
    const rel = relative(rt.worktree, abs).split(sep).join('/');
    if (!raw) return { ok: false, target: '(нет пути)', reason: 'не указан путь' };
    if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, target: raw, reason: 'вне worktree' };
    if (readOnly) return { ok: false, target: rel, reason: 'шаг только на чтение' };
    if (!matchesAny(rel, rp.write.map(sub))) return { ok: false, target: rel, reason: `роли ${roleName} запись сюда не разрешена` };
    if (matchesAny(rel, (rp.denyWrite ?? []).map(sub))) return { ok: false, target: rel, reason: 'защищённый путь' };
    return { ok: true, target: rel, reason: 'разрешено policy' };
  }
  if (SHELL_TOOLS.has(toolName)) {
    const cmd = String(input['command'] ?? '').trim();
    const m = cmd.match(/^(?:\.\/)?tools\/agentflow\/run\.sh\s+([a-z0-9-]+)$/);
    if (!m) return { ok: false, target: cmd, reason: 'разрешён только ./tools/agentflow/run.sh <операция>' };
    if (readOnly || !rp.shell.includes(m[1]!)) return { ok: false, target: cmd, reason: `операция ${m[1]} роли не разрешена` };
    return { ok: true, target: cmd, reason: 'операция runner из policy' };
  }
  return { ok: false, target: toolName, reason: 'инструмент не в политике роли' };
}

export function aclFor(rt: RoleRuntime, roleName: string, readOnly: boolean): CanUseTool {
  return async (toolName, input) => {
    const d = decideAcl(rt, roleName, readOnly, toolName, input);
    log.acl(roleName, toolName, d.target, d.ok, d.reason);
    rt.ledger({ ev: 'acl', role: roleName, tool: toolName, target: d.target, allowed: d.ok, reason: d.reason });
    return d.ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `agentflow ACL: ${d.reason}` };
  };
}

export function toolsFor(role: RoleDef, readOnly?: boolean): string[] {
  return readOnly ? role.tools.filter((t) => READ_TOOLS.includes(t)) : role.tools;
}

function toolArg(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const v = o['file_path'] ?? o['path'] ?? o['command'] ?? o['pattern'] ?? o['absolute_path'] ?? o['dir_path'];
  return v === undefined ? '' : oneLine(String(v), 100);
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
  const tools = toolsFor(role, call.readOnly);
  const effort = rt.policy.qwen.effortViaSdk ? role.effort : undefined;
  log.spawn(role.name, { model: role.model, effort, session: sessionId, resume: !!call.resume, tools });

  const abortController = new AbortController();
  const minutes = rt.policy.limits.roleTimeoutMinutes;
  const timer = minutes > 0 ? setTimeout(() => abortController.abort(), minutes * 60_000) : undefined;
  const exe = qwenExecutable(rt.policy);
  const authType = qwenAuthType(rt.policy);
  const options: QueryOptions = {
    cwd: call.cwd,
    model: role.model,
    systemPrompt: { type: 'preset', preset: 'qwen_code', append: role.prompt },
    permissionMode: 'default',
    coreTools: tools,
    excludeTools: rt.policy.denyAll,
    canUseTool: aclFor(rt, role.name, !!call.readOnly),
    maxSessionTurns: role.maxTurns,
    includeDirectories: [rt.contextsDir],
    abortController,
    debug: rt.policy.qwen.debug,
    stderr: (text) => rt.ledger({ ev: 'stderr', role: role.name, text }),
    ...(call.resume ? { resume: call.resume } : { sessionId }),
    ...(effort ? { effort } : {}),
    ...(exe ? { pathToQwenExecutable: exe } : {}),
    ...(authType ? { authType } : {}),
  };

  const started = Date.now();
  const models = new Set<string>();
  let result: SDKResultMessage | undefined;
  let error: string | undefined;
  try {
    const q = query({ prompt: call.prompt, options });
    for await (const m of q) {
      rt.ledger({ ev: 'sdk', step: call.label, role: role.name, msg: m });
      if (isSDKSystemMessage(m) && m.subtype === 'init') {
        log.role(role.name, c.gray(`сессия открыта · модель ${m.model ?? '?'} · режим ${m.permission_mode ?? '?'} · инструментов ${m.tools?.length ?? 0}`));
      } else if (isSDKAssistantMessage(m)) {
        if (m.message.model) models.add(m.message.model);
        for (const b of m.message.content) {
          if (b.type === 'text' && b.text.trim()) log.role(role.name, '«' + oneLine(b.text, 220) + '»');
          else if (b.type === 'thinking') log.role(role.name, c.gray(`… размышляет (${b.thinking.length} симв.)`));
          else if (b.type === 'tool_use') log.role(role.name, `→ ${b.name} ${toolArg(b.input)}`);
        }
      } else if (isSDKUserMessage(m) && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === 'tool_result' && b.is_error) log.role(role.name, c.red('✗ ' + oneLine(blockText(b.content), 160)));
        }
      } else if (isSDKResultMessage(m)) {
        result = m;
      }
    }
  } catch (e) {
    error = abortController.signal.aborted ? `таймаут роли ${minutes} мин` : e instanceof Error ? e.message : String(e);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const base = { sessionId, seconds, models: [...models] };
  if (!result) return { ...base, ok: false, text: '', error: error ?? 'сессия завершилась без result', turns: 0, denials: 0 };
  const info = {
    turns: result.num_turns,
    denials: result.permission_denials.length,
    usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
  };
  log.roleDone(role.name, { turns: info.turns, seconds, models: base.models, denials: info.denials });
  if (result.is_error) {
    return { ...base, ...info, ok: false, text: '', error: `${result.subtype}${result.error?.message ? ': ' + result.error.message : ''}` };
  }
  const text = result.result;
  if (!text.trim()) return { ...base, ...info, ok: false, text, error: 'пустой ответ' };
  return { ...base, ...info, ok: true, text };
}
