// Контроллер agentflow: детерминированный конечный автомат конвейера spec-driven разработки.
// Пять ролей только предлагают артефакты, код и вердикты; переходы, гейты, git и решения
// о прохождении принимает этот код. Каждая роль — отдельная сессия @qwen-code/sdk.
//
//   npm run agentflow -- run tasks/01-slugify.md [--auto-approve] [--inject all] [--mock]
//   npm run agentflow -- resume <run-id>
//   npm run agentflow -- status [<run-id>]
//   npm run agentflow -- agents [<run-id>]
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import {
  acceptancePrompt,
  authorPrompt,
  clarifyPrompt,
  codeReviewPrompt,
  decisionDiscussPrompt,
  discussPrompt,
  finalReviewPrompt,
  formatDiscussion,
  holisticPrompt,
  implementerPrompt,
  indexRequirements,
  loadRubric,
  batchesFromTasks,
  parseDecisionReply,
  parseDiscussReply,
  specReviewPrompt,
  writeContext,
  type BaseCtx,
  type Requirement,
  type TaskBatch,
} from './context-builder.ts';
import { showAgents } from './agents.ts';
import { KIT, resolveRepo } from './config.ts';
import { runGates, gatesSummary, type GateResult } from './gates.ts';
import { addWorktree, branchExists, changedPaths, commitAll, currentBranch, diff, diffNoIndex, ensureIgnored, ensureRepo, gitPath, head, switchNew } from './git.ts';
import { autopilotOn, checkModeFlags, untilReviewPick } from './autopilot.ts';
import { askHuman, blocker, PassLoop, Scopes, type PassScope } from './dialogs.ts';
import { Human, replies, type Choice, type Discuss } from './human.ts';
import { INJECT_HELP, Injector, parseInject } from './inject.ts';
import { aclRetryAddendum, diagnose, INTERVENTION_OPTIONS, recommendIntervention, type InterventionChoice } from './intervention.ts';
import { c, configureThinking, log, parseThinkingChars, setLogSink, THINKING_CHARS } from './log.ts';
import { runMock } from './mock.ts';
import { mouse, mouseEnabled } from './mouse.ts';
import { OpenSpec, topoOrder, type ArtifactNode } from './openspec.ts';
import { loadPolicy, qwenExecutable, type Policy } from './policy.ts';
import { printLoopSummary, writeAcceptanceReport } from './report.ts';
import { decide, countBySeverity, validateReview, type Decision, type Expectation, type Review, type ReviewFinding } from './review-validator.ts';
import { expandGlob, loadRoles, mcpViolations, mcpWarnings, roleFiles, runRole, stallMs, type RoleCall, type RoleDef, type RoleResult, type RoleRuntime, type TaskMeta } from './roles.ts';
import { screen } from './screen.ts';
import { artifactFiles, artifactSnapshot, artifactText, codeSnapshot, specDigest } from './snapshot.ts';
import { clock, panelEnabled, panel } from './status-panel.ts';
import { fromMenu, parseSkipRoles, ROLES, settingsMenu, skippedSteps, specOnly, validateMenu, type RunSettings } from './run-settings.ts';
import { foreignDirty, inMainTree, lockTree, mergeSteps, RUNS_DIR, TREE_LOCK, treeChanges } from './run-tree.ts';
import { RunStore, STAGES, type BatchState, type DiscussTurn, type Finding, type Question, type QuestionOption, type RunState, type Stage } from './state.ts';
import { Blocked, exec, extractJson, matchesAny, now, oneLine, Parked, sha256, short, stamp } from './util.ts';

/** Целевой репозиторий: git-корень, из которого запущен agentflow (или --repo). Задаётся в main. */
let ROOT = KIT;
/** --no-panel: без панели статуса внизу терминала. */
let NO_PANEL = false;
/** --no-mouse: без режима мыши (клик по размышлению не раскрывает его). */
let NO_MOUSE = false;

interface Ctx {
  root: string;
  /** Дерево, где run меняет код: основное дерево репозитория или worktree run. */
  wt: string;
  runDir: string;
  contextsDir: string;
  /** Копия контракта ревью в contexts/: роли читают её, путь kit им недоступен. */
  schemaPath: string;
  reviewsDir: string;
  gatesDir: string;
  store: RunStore;
  policy: Policy;
  roles: Map<string, RoleDef>;
  os: OpenSpec;
  rt: RoleRuntime;
  human: Human;
  inject: Injector;
  /** Петли, которые сейчас можно пройти решением человека: верхняя — текущая. */
  scopes: Scopes;
  graph: ArtifactNode[];
  /** Артефакты, которые требует apply (файл задач) — из схемы репозитория. */
  tracked: Set<string>;
}

const st = (ctx: Ctx): RunState => ctx.store.state;
const changeDir = (ctx: Ctx) => `openspec/changes/${st(ctx).change}`;
const changeDirAbs = (ctx: Ctx) => join(ctx.wt, changeDir(ctx));
const base = (ctx: Ctx): BaseCtx => ({ change: st(ctx).change, changeDir: changeDir(ctx), intent: st(ctx).intent.text, clarifications: st(ctx).intent.clarifications, schemaPath: ctx.schemaPath });
const node = (ctx: Ctx, id: string) => ctx.graph.find((n) => n.id === id)!;
/** Роль включена в настройках run: шаги выключенной пропускаются. */
const on = (ctx: Ctx, role: string) => !st(ctx).options.skip.includes(role);
/** Run только со спекой (implementer выключен): после freeze нет apply, acceptance, финала и archive. */
const specRun = (ctx: Ctx) => specOnly(st(ctx).options.skip);
const CODE_STAGES: readonly Stage[] = ['apply', 'acceptance', 'final'];

// ───────────────────────────── вызовы ролей ─────────────────────────────

function role(ctx: Ctx, name: string): RoleDef {
  const r = ctx.roles.get(name);
  if (!r) throw new Error(`нет роли ${name} в .qwen/agents/`);
  return r;
}

/** MCP-вызовы против policy: защита второй линии для инструментов, которые CLI выполнил без ACL. */
function checkMcp(ctx: Ctx, roleName: string, readOnly: boolean | undefined, res: RoleResult): void {
  const bad = mcpViolations(ctx.policy, roleName, readOnly, res.mcpCalls ?? []);
  if (bad.length) throw new Blocked(`${roleName} вызвал MCP-инструменты вне roles.${roleName}.mcp: ${bad.join(', ')}`);
}

function account(ctx: Ctx, r: RoleDef, res: RoleResult): void {
  const s = st(ctx);
  const m = (s.models[r.name] ??= { requested: r.model, effort: r.effort, actual: [] });
  for (const a of res.models) if (!m.actual.includes(a)) m.actual.push(a);
  const u = (s.usage[r.name] ??= { calls: 0, turns: 0, inputTokens: 0, outputTokens: 0, seconds: 0 });
  u.calls++;
  u.turns += res.turns;
  u.seconds += res.seconds;
  u.inputTokens += res.usage?.input_tokens ?? 0;
  u.outputTokens += res.usage?.output_tokens ?? 0;
  ctx.store.save();
}

/** Диалог с «Остановить run»: хвост меню, переход дальше по текущей петле, точки inject контроллера. */
async function ask<K extends string>(ctx: Ctx, ch: Choice<K>): Promise<K> {
  return (await askHuman(ctx.human, ch, { scopes: ctx.scopes, inject: (p) => ctx.inject.take(p) }))!;
}

/**
 * Петля в своей области: «Всё равно перейти дальше» в любом её диалоге закрывает её через onPass.
 * Глубина лога возвращается к той, что была до петли: переход мог случиться посреди раунда.
 */
function passLoop<T>(ctx: Ctx, scope: PassScope, fn: () => Promise<T>, onPass: (reason: string) => T | Promise<T>): Promise<T> {
  const depth = log.depth();
  return ctx.scopes.passable(scope, fn, (reason) => {
    log.depth(depth);
    return onPass(reason);
  });
}

/** Петля пройдена решением человека: её незакрытые находки снимаются с причиной, переход — в state.json. */
function closeLoop(ctx: Ctx, scope: PassScope, reason: string, snapshot: string): void {
  const s = st(ctx);
  const open = openFindings(ctx, scope.loop);
  for (const f of open) {
    f.status = 'waived';
    f.waiver = { reason, at: now(), snapshot };
  }
  s.proceeded.push({ at: now(), loop: scope.loop, label: scope.label, reason, findings: open.map((f) => f.id) });
  s.decisions.push({ at: now(), gate: `proceed:${scope.loop}`, decision: 'proceed', comment: reason });
  ctx.store.save();
  log.warn(`${scope.loop}: пройдено решением человека — ${scope.label}${open.length ? ` · сняты ${open.map((f) => f.id).join(', ')}` : ''} · причина: ${reason}`);
}

/** Режим --auto-until-review: автопилот берёт ещё раунд вместо рекомендованного waiver. */
function modePick(ctx: Ctx, recommended: string): { autoPick?: { key: 'more'; why: string } } {
  const pick = st(ctx).options.untilReview ? untilReviewPick(recommended) : undefined;
  return pick ? { autoPick: pick } : {};
}

/** Реплика автопилота при fault injection discuss-dialog. */
const DISCUSS_DIALOG_MESSAGE = 'Какие из находок действительно блокируют и что даст каждый вариант?';

/**
 * Обсуждение решения с ролями петли: реплика — сессия только на чтение без серии повторов, как у
 * вопроса. Переписка пишется в state.json под гейтом и номером показа диалога.
 */
function talk<K extends string>(ctx: Ctx, gate: string, roles: string[], files: string[], ch: Choice<K>, o: { exhausted?: boolean } = {}): Choice<K> {
  const s = st(ctx);
  roles = roles.filter((r) => on(ctx, r));
  const key = `${gate}#${Object.keys(s.dialogs).filter((k) => k.startsWith(`${gate}#`)).length + 1}`;
  const history: DiscussTurn[] = [];
  const scope = ctx.scopes.top();
  const options = [
    ...ch.options.filter((x) => x.key !== 'stop'),
    { label: 'Остановить run (BLOCKED, потом resume)' },
    ...(scope ? [{ label: `Всё равно перейти дальше: ${scope.label}` }] : []),
  ];
  return {
    ...ch,
    discuss: {
      roles,
      history,
      limit: ctx.policy.limits.discussTurns,
      autoMessage: o.exhausted && roles.length > 0 && ctx.inject.take('discuss-dialog') ? DISCUSS_DIALOG_MESSAGE : undefined,
      reply: (name, message, prev) => {
        const turn = prev.length + 1;
        const label = `dialog-${key.replace(/[^\p{L}\p{N}]+/gu, '-')}-${turn}`;
        const prompt = decisionDiscussPrompt(base(ctx), {
          gate,
          role: name,
          title: ch.title,
          context: ch.context ?? [],
          options,
          recommended: ch.options.find((x) => x.key === ch.recommended)?.label ?? String(ch.recommended),
          rationale: ch.rationale,
          files,
          history: prev,
          message,
        });
        return replyTurn(ctx, name, label, prompt, { kind: 'discuss-decision', gate }, parseDecisionReply, `dialog:${gate}`, turn);
      },
      onTurn: () => {
        s.dialogs[key] = history;
        ctx.store.save();
      },
    },
  };
}

/**
 * Одна реплика роли в сессии только на чтение. Своя область: переход дальше в диалоге простоя
 * реплики — ответа нет, меню показывается снова, петля, в которой открыт диалог, не проходится.
 */
async function replyTurn<T extends object>(
  ctx: Ctx,
  name: string,
  label: string,
  prompt: string,
  meta: TaskMeta,
  parse: (text: string) => T | { error: string },
  loop: string,
  turn: number,
  intervene: Intervene = interventionHandler(ctx, label),
): Promise<T | { error: string }> {
  const r = role(ctx, name);
  writeContext(ctx.contextsDir, label, prompt);
  return ctx.scopes.passable(
    { loop: 'reply', label: 'вернуться к меню без ответа роли' },
    async () => {
      const res = await runRole(ctx.rt, { role: r, prompt, label, cwd: ctx.wt, readOnly: true, meta, intervene });
      account(ctx, r, res);
      checkMcp(ctx, name, true, res);
      afterIntervention(label, name, res, intervene);
      const out = res.ok ? parse(res.text) : { error: res.error ?? 'неизвестная ошибка' };
      ctx.store.loop(loop, turn, 'error' in out ? 'ERROR' : 'REPLY', 'error' in out ? String(out.error) : undefined);
      return out;
    },
    (reason) => ({ error: `реплика оставлена без ответа: ${reason}` }),
  );
}

/** Решение после обсуждения: число реплик — в решение, переписка — автору следующего раунда. */
function talkComment(ch: Choice): string | undefined {
  const n = ch.discuss?.history.length ?? 0;
  return n ? `обсуждение: ${replies(n)}` : undefined;
}

function talkNote(ch: Choice): string | undefined {
  const h = ch.discuss?.history ?? [];
  return h.length ? `Человек обсудил решение с ролями петли, учти это при исправлении.\n${formatDiscussion(h)}` : undefined;
}

/**
 * Блокер роли: диалог вместо остановки. «Остановить run» (рекомендуется) — Blocked с причиной,
 * переход дальше — PassLoop текущей петли. Контекст человека (и переписка обсуждения) уходит в
 * уточнения intent: его видят все роли; вызывающий повторяет шаг.
 */
async function onBlocker(
  ctx: Ctx,
  b: { gate: string; title: string; reason: string; roles: string[]; files: string[]; context?: string[]; retry?: string; ask?: string },
): Promise<{ text: string; note?: string }> {
  let ch: Choice | undefined;
  await blocker(
    ctx.human,
    { title: b.title, reason: b.reason, context: b.context, retry: b.retry, decorate: (x) => (ch = talk(ctx, b.gate, b.roles, b.files, x)) as typeof x },
    { scopes: ctx.scopes, inject: (p) => ctx.inject.take(p) },
  );
  const s = st(ctx);
  s.decisions.push({ at: now(), gate: b.gate, decision: 'context', comment: ch && talkComment(ch) });
  const text = await ctx.human.text(b.ask ?? 'Недостающий контекст', 'используй intent и код репозитория как единственный источник');
  const note = ch && talkNote(ch);
  s.intent.clarifications.push({ question: `${b.gate}: ${b.reason}`, answer: text, ...(ch?.discuss?.history.length ? { discussion: ch.discuss.history } : {}) });
  ctx.store.save();
  return { text, note };
}

/** Серия повторов закончилась ошибкой: человек решает, повторить ещё серию или остановить run. */
async function infraExhausted(ctx: Ctx, what: string, error: string, series: number): Promise<void> {
  const k = await ask(ctx, {
    title: `${what}: ${ctx.policy.limits.infraRetries + 1} попыток подряд закончились ошибкой`,
    context: [`последняя ошибка: ${oneLine(error, 300)}`, `подробности: ${ctx.store.ledgerPath} (ev: stderr)`],
    options: [
      { key: 'retry', label: 'Повторить ещё серию попыток', description: 'тот же шаг, новые сессии' },
      { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)', description: 'устранить причину (CLI, модель, сеть) и продолжить командой resume' },
    ],
    recommended: series === 1 ? 'retry' : 'stop',
    rationale: series === 1 ? 'сбой мог быть разовым: сеть или перегрузка модели' : 'повторная серия тоже не помогла — причина устойчивая, её нужно устранить',
  });
  if (k === 'stop') throw new Blocked(`${what}: ${error}`);
}

/**
 * Решение о вмешательстве в работающую сессию шага. Счётчик простоев один на все попытки и серии
 * шага: так --auto-approve идёт по цепочке «ждать → повторить → стоп», а не ждёт вечно.
 */
/** Обработчик вмешательства; passed — переход дальше, который исполнит afterIntervention после прерывания сессии. */
type Intervene = NonNullable<RoleCall['intervene']> & { passed?: PassLoop };

function interventionHandler(ctx: Ctx, label: string): Intervene {
  let stalls = 0;
  const h: Intervene = async (ev, signal) => {
    if (ev.kind === 'stall') stalls++;
    const opened = Date.now();
    const rec = recommendIntervention(ev, stalls);
    const hints = [...new Set(ev.denials.map((d) => d.hint).filter(Boolean))].map((h) => `что делать: ${h}`);
    let k: InterventionChoice | undefined;
    try {
      k = await askHuman(
        ctx.human,
        {
          title: ev.kind === 'stall' ? `${label}: роль ${ev.role} молчит ${clock(ev.idleMs)}` : `${label}: роль ${ev.role} упирается в ACL`,
          context: [diagnose(ev), ...hints, `подробности: ${ctx.store.ledgerPath}`],
          options: INTERVENTION_OPTIONS,
          recommended: rec.choice,
          rationale: rec.rationale,
        },
        { scopes: ctx.scopes, inject: (p) => ctx.inject.take(p), signal },
      );
    } catch (e) {
      // Сторож ждёт решение, а не исключение: переход дальше исполняется после прерывания сессии.
      if (!(e instanceof PassLoop)) throw e;
      h.passed = e;
      return 'proceed';
    }
    if (k !== undefined) return k;
    log.info(
      ev.kind === 'stall'
        ? `${ev.role}: сессия ожила после ${clock(ev.idleMs + Date.now() - opened)} простоя — ждём дальше`
        : `${ev.role}: сессия завершилась, пока был открыт диалог`,
    );
    return 'woke';
  };
  return h;
}

/**
 * Сессию прервали по решению о вмешательстве: стоп — BLOCKED, переход дальше — PassLoop петли,
 * после серии ACL — подсказка в промпт повтора.
 */
function afterIntervention(label: string, name: string, res: RoleResult, intervene: Intervene): string {
  if (res.intervention?.decision === 'stop') throw new Blocked(`${label}: роль ${name}: ${res.error}`);
  if (res.intervention?.decision === 'proceed') throw intervene.passed ?? new Error(`${label}: переход дальше без петли`);
  return res.intervention?.kind === 'acl-streak' ? '\n\n' + aclRetryAddendum(res.intervention.denials) : '';
}

/** Точки inject первой сессии роли: stall:<роль> (молчит) и think-long:<роль> (долго размышляет). */
function sessionInject(ctx: Ctx, name: string): Partial<TaskMeta> {
  return { ...(ctx.inject.take(`stall:${name}`) ? { silent: true } : {}), ...(ctx.inject.take(`think-long:${name}`) ? { thinkLong: true } : {}) };
}

/** Вызов роли с повторами на инфраструктурных ошибках (таймаут, пустой ответ, сбой CLI). */
async function callRole(
  ctx: Ctx,
  name: string,
  prompt: string,
  meta: TaskMeta,
  opts: { label: string; readOnly?: boolean; resume?: string },
): Promise<RoleResult> {
  const r = role(ctx, name);
  writeContext(ctx.contextsDir, opts.label, prompt);
  const tries = ctx.policy.limits.infraRetries + 1;
  const intervene = interventionHandler(ctx, opts.label);
  let once = sessionInject(ctx, name);
  let addendum = '';
  for (let series = 1; ; series++) {
    let lastError = '';
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (addendum) writeContext(ctx.contextsDir, `${opts.label}-acl-retry`, prompt + addendum);
      const res = await runRole(ctx.rt, {
        role: r,
        prompt: prompt + addendum,
        label: opts.label,
        cwd: ctx.wt,
        readOnly: opts.readOnly,
        resume: attempt === 1 && series === 1 ? opts.resume : undefined,
        meta: { ...meta, ...once },
        intervene,
      });
      once = {};
      account(ctx, r, res);
      checkMcp(ctx, name, opts.readOnly, res);
      if (res.ok) return res;
      addendum = afterIntervention(opts.label, name, res, intervene) || addendum;
      lastError = res.error ?? 'неизвестная ошибка';
      log.warn(`${name}: ошибка шага (${lastError}) — попытка ${attempt}/${tries}`);
    }
    await infraExhausted(ctx, `${opts.label}: роль ${name}`, lastError, series);
  }
}

/** Реплика автопилота при fault injection discuss-question. */
const DISCUSS_INJECT_MESSAGE = 'Чем варианты отличаются для вызывающего кода?';

/**
 * Обсуждение вопроса с ролью, которая его задала. Реплика — одна сессия только на чтение без
 * серии повторов: человек ждёт ответа перед меню и при сбое повторит сам. Переписка и уточнённые
 * варианты вопроса из state (persist) сохраняются после каждой реплики — для resume.
 */
function discussFor(ctx: Ctx, q: { id: string; from: string; artifact?: string; options?: QuestionOption[] }, persist?: Question): Discuss {
  const name = q.from;
  const n = q.artifact ? ctx.graph.find((x) => x.id === q.artifact) : undefined;
  const files = n ? filesOf(ctx, n) : [];
  const intervene = interventionHandler(ctx, `discuss-${q.id}`);
  const autoMessage = q.options?.length && ctx.inject.take('discuss-question') ? DISCUSS_INJECT_MESSAGE : undefined;
  return {
    role: name,
    history: persist?.discussion ?? [],
    limit: ctx.policy.limits.discussTurns,
    autoMessage,
    reply: async (message, history, v) => {
      const turn = history.length + 1;
      const label = `discuss-${q.id}-${turn}`;
      const prompt = discussPrompt(base(ctx), { id: q.id, question: v.question, why: v.why, options: v.options, recommended: v.recommended, rationale: v.rationale, files, history, message });
      const meta: TaskMeta = { kind: 'discuss', discuss: { id: q.id, options: v.options, recommended: v.recommended } };
      return replyTurn(ctx, name, label, prompt, meta, parseDiscussReply, `discuss:${q.id}`, turn, intervene);
    },
    onTurn: (t, v) => {
      if (!persist) return;
      Object.assign(persist, { options: v.options, recommended: v.recommended, rationale: v.rationale, discussion: [...(persist.discussion ?? []), t] });
      ctx.store.save();
    },
  };
}

/** Комментарий решения по вопросу: число реплик обсуждения видно в ACCEPTANCE.md. */
function questionComment(question: string, discussion: DiscussTurn[]): string {
  return discussion.length ? `${question} · обсуждение: ${replies(discussion.length)}` : question;
}

/** Решение человека по вопросу для автора: ответ и, если было, обсуждение. */
function questionDecision(question: string, answer: string, discussion: DiscussTurn[]): string {
  return `Решение человека по вопросу «${question}»: ${answer}` + (discussion.length ? '\n' + formatDiscussion(discussion, '  ') : '');
}

/** Вызов ревьюера: битый JSON и нарушение контракта — ошибка шага, а не вердикт. */
async function callReviewer(
  ctx: Ctx,
  name: string,
  prompt: string,
  meta: TaskMeta,
  exp: Expectation,
  label: string,
): Promise<Review> {
  const r = role(ctx, name);
  const tries = ctx.policy.limits.infraRetries + 1;
  const intervene = interventionHandler(ctx, label);
  let once = sessionInject(ctx, name);
  let addendum = '';
  for (let series = 1; ; series++) {
    let lastError = '';
    for (let attempt = 1; attempt <= tries; attempt++) {
      const p =
        (lastError ? `${prompt}\n\n## Предыдущий ответ отклонён валидатором контракта\n${lastError}\nВерни ответ строго по контракту.` : prompt) +
        addendum;
      const tag = series === 1 && attempt === 1 ? label : `${label}-retry${series}.${attempt}`;
      writeContext(ctx.contextsDir, tag, p);
      const res = await runRole(ctx.rt, { role: r, prompt: p, label, cwd: ctx.wt, meta: { ...meta, ...once }, intervene });
      once = {};
      account(ctx, r, res);
      checkMcp(ctx, name, false, res);
      if (!res.ok) {
        addendum = afterIntervention(label, name, res, intervene) || addendum;
        lastError = res.error ?? 'неизвестная ошибка';
        log.warn(`${name}: ошибка шага (${lastError}) — попытка ${attempt}/${tries}`);
        continue;
      }
      let text = res.text;
      if (name === 'spec-reviewer' && ctx.inject.take('review-bad-json')) text = '{"status": "PASS", "findings": [ {"id": обрыв ответа';
      const v = validateReview(text, exp);
      writeFileSync(join(ctx.reviewsDir, `${tag}.json`), text);
      if (!v.ok) {
        lastError = v.error;
        log.warn(`контракт ответа нарушен: ${v.error} — новый экземпляр ревьюера, попытка ${attempt + 1}/${tries}`);
        continue;
      }
      for (const n of v.notes) log.step(`валидатор контракта: ${n}`);
      return v.review;
    }
    await infraExhausted(ctx, `${label}: ответ ${name} не по контракту`, lastError, series);
  }
}

// ───────────────────────────── findings ─────────────────────────────

function openFindings(ctx: Ctx, loop: string): Finding[] {
  return st(ctx).findings.filter((f) => f.step === loop && (f.status === 'open' || f.status === 'fixed' || f.status === 'disputed'));
}

function synthetic(ctx: Ctx, loop: string, round: number, source: string, f: Partial<Finding> & Pick<Finding, 'problem' | 'location'>): Finding {
  const prefix = { validator: 'V', gate: 'G', human: 'H', inject: 'INJ' }[source] ?? 'S';
  const n = st(ctx).findings.filter((x) => x.id.startsWith(prefix + '-')).length + 1;
  const finding: Finding = { id: `${prefix}-${String(n).padStart(3, '0')}`, severity: 'major', evidence: source, source, step: loop, round, status: 'open', ...f };
  st(ctx).findings.push(finding);
  ctx.store.save();
  return finding;
}

/** Синтетические находки (валидатор, гейт, человек, inject) закрываются, когда переданы автору. */
function consume(ctx: Ctx, findings: Finding[]): void {
  for (const f of findings) if (f.source !== 'spec-reviewer' && f.source !== 'code-reviewer' && f.source !== 'acceptance-tester') f.status = 'closed';
  ctx.store.save();
}

/** Ответы автора: fixed или disputed с доказательством. Закрывает находку ревьюер следующего раунда. */
function applyResponses(ctx: Ctx, loop: string, text: string): Record<string, unknown> | undefined {
  const j = extractJson(text) as Record<string, unknown> | undefined;
  const responses = Array.isArray(j?.['responses']) ? (j!['responses'] as { id: string; resolution: string; evidence: string }[]) : [];
  for (const r of responses) {
    const f = openFindings(ctx, loop).find((x) => x.id === r.id);
    if (f && (r.resolution === 'fixed' || r.resolution === 'disputed')) {
      f.status = r.resolution;
      f.response = { resolution: r.resolution, evidence: String(r.evidence ?? '') };
    }
  }
  ctx.store.save();
  return j;
}

/** Жизненный цикл находок по ревью: неповторённые закрываются, повторённые снова open. */
async function applyReview(ctx: Ctx, loop: string, round: number, review: Review, d: Decision): Promise<void> {
  const prev = openFindings(ctx, loop);
  const raised = new Set(review.findings.map((f) => f.id));
  for (const p of prev) if (!raised.has(p.id) && p.source === review.role) p.status = 'closed';
  for (const f of review.findings) {
    const existing = prev.find((p) => p.id === f.id && p.source === review.role);
    const blocking = d.blocking.includes(f);
    // Спор о безопасности или утверждённом поведении LLM не прощает.
    if (existing?.status === 'disputed' && blocking && (f.category === 'security' || f.category === 'behavior')) {
      const author = loop.startsWith('artifact:') || loop === 'holistic' ? 'spec-author' : 'implementer';
      // Находка остаётся open: автор получает её следующим раундом, а решение человека — в уточнениях.
      await onBlocker(ctx, {
        gate: `dispute:${loop}:${f.id}`,
        title: `${loop}: спор по находке ${f.id} (${f.category})`,
        reason: `${loop}: спор по находке ${f.id} (${f.category}) — нужно решение человека: ${f.problem}`,
        context: [`ответ автора: ${oneLine(existing.response?.evidence ?? '—', 200)}`, `ревьюер повторил: ${oneLine(f.evidence, 200)}`],
        roles: [...new Set([review.role, author])],
        files: [],
        retry: 'Решить спор указанием и продолжить',
        ask: `Решение спора по ${f.id}`,
      });
    }
    const status = blocking || (f.needsHuman ?? false) ? 'open' : 'logged';
    if (existing) Object.assign(existing, f, { round, status });
    else st(ctx).findings.push({ ...f, source: review.role, step: loop, round, status });
  }
  ctx.store.save();
}

function stored(ctx: Ctx, loop: string, fs: ReviewFinding[]): Finding[] {
  return fs.map((f) => st(ctx).findings.find((x) => x.step === loop && x.id === f.id && x.status === 'open')!).filter(Boolean);
}

/** Вердикт финала без code-reviewer: только полные гейты, красные — одна находка critical. */
function gatesOnlyReview(gates: GateResult[], snap: string, round: number): Review {
  const red = gates.filter((g) => !g.ok);
  return {
    status: red.length ? 'REVISE' : 'PASS',
    role: 'gates',
    target: 'final',
    snapshotId: snap,
    round,
    checks: [],
    findings: red.length
      ? [{ id: `GATES-${round}`, severity: 'critical', location: red[0]!.logPath, problem: `полные гейты красные: ${red.map((g) => g.op).join(', ')}`, evidence: gatesSummary(gates, 20) }]
      : [],
  };
}

/** Fault injection blocked:<петля>: ревьюер не может проверить — BLOCKED с недостающим контекстом. */
function injectBlocked(ctx: Ctx, loop: string, review: Review): Review {
  if (!ctx.inject.take(`blocked:${loop}`)) return review;
  return { ...review, status: 'BLOCKED', missingContext: [`fault injection blocked:${loop}`] };
}

function injectRevise(review: Review, location: string, round: number, id = 'INJ-001'): Review {
  return {
    ...review,
    status: 'REVISE',
    round,
    findings: [
      ...review.findings,
      {
        id,
        severity: 'major',
        location,
        problem: '[fault-injection] принудительный REVISE для проверки петли исправлений',
        evidence: 'fault injection контроллера (--inject)',
        requiredChange: 'Перечитай свою работу по рубрике и исправь неточности; если их нет — ответь disputed',
        category: 'other',
      },
    ],
  };
}

/** Снять находки человеком с причиной; waiver действует только на текущем snapshot. */
function waive(ctx: Ctx, findings: Finding[], reason: string, snapshot: string): void {
  for (const f of findings) {
    f.status = 'waived';
    f.waiver = { reason, at: now(), snapshot };
  }
  st(ctx).decisions.push({ at: now(), gate: 'waiver', decision: findings.map((f) => f.id).join(', '), comment: reason });
  ctx.store.save();
  log.info(c.yellow(`waiver: ${findings.map((f) => f.id).join(', ')} — ${reason}`));
}

/** Повторно поднятые находки, уже снятые человеком на этом же snapshot, не блокируют. */
function honorWaivers(ctx: Ctx, loop: string, snapshot: string, d: Decision): Decision {
  const waived = new Set(st(ctx).findings.filter((f) => f.step === loop && f.waiver?.snapshot === snapshot).map((f) => f.id));
  const blocking = d.blocking.filter((f) => !waived.has(f.id));
  if (blocking.length === d.blocking.length) return d;
  return { ...d, blocking, verdict: d.verdict === 'REVISE' && !blocking.length ? 'PASS' : d.verdict, reason: `${d.reason}; снято waiver: ${d.blocking.length - blocking.length}` };
}

/** Сколько раз по этой петле уже открывался диалог исчерпания: с третьего раза рекомендуется остановиться. */
function exhaustedBefore(ctx: Ctx, gate: string): number {
  return st(ctx).decisions.filter((d) => d.gate === gate).length;
}

/** Одни и те же находки два раунда подряд — автор не сходится. */
function stuck(history: string[][]): boolean {
  const [a, b] = history.slice(-2);
  return !!a && !!b && a.length > 0 && a.every((id) => b.includes(id));
}

type QuestionItem = {
  question: string;
  why?: string;
  options?: (string | { label?: string; description?: string })[];
  recommended?: number;
  rationale?: string;
  artifact?: string | null;
};

function collectQuestions(ctx: Ctx, from: string, artifact: string, items: QuestionItem[]): void {
  const qs = st(ctx).spec.questions;
  for (const q of items) {
    if (!q.question || qs.some((x) => x.question === q.question)) continue;
    const options = (q.options ?? [])
      .map((o) => (typeof o === 'string' ? { label: o } : { label: String(o.label ?? ''), description: o.description }))
      .filter((o) => o.label);
    qs.push({ id: `Q-${qs.length + 1}`, question: q.question, why: q.why, options, recommended: q.recommended, rationale: q.rationale, artifact: q.artifact ?? artifact, from });
    log.step(`вопрос к тебе отложен до твоего ревью артефакта «${q.artifact ?? artifact}»: ${q.question}`);
  }
  ctx.store.save();
}

// ───────────────────────────── фаза спеки ─────────────────────────────

function upstreamOf(ctx: Ctx, n: ArtifactNode) {
  return n.requires.map((id) => ({ id, files: artifactFiles(changeDirAbs(ctx), node(ctx, id).outputPath) }));
}

function snapshotOf(ctx: Ctx, n: ArtifactNode): string {
  const ups = n.requires.map((id) => st(ctx).spec.artifacts[id]?.snapshot ?? 'none');
  return artifactSnapshot(changeDirAbs(ctx), n.outputPath, ups);
}

async function validateArtifact(ctx: Ctx, n: ArtifactNode, loop: string, round: number): Promise<Finding[]> {
  return (await validationProblems(ctx, n)).map((p) => synthetic(ctx, loop, round, 'validator', { ...p, evidence: 'детерминированная валидация контроллера' }));
}

/** Проблемы детерминированной валидации артефакта — без находок в state (для проверки перехода дальше). */
async function validationProblems(ctx: Ctx, n: ArtifactNode): Promise<{ problem: string; location: string }[]> {
  const out: { problem: string; location: string }[] = [];
  const files = artifactFiles(changeDirAbs(ctx), n.outputPath);
  const vf = (problem: string, location: string) => ({ problem, location });
  if (!files.length) out.push(vf(`не создан ни один файл ${n.outputPath}`, `${changeDir(ctx)}/${n.outputPath}`));
  const status = (await ctx.os.artifacts(st(ctx).change)).find((a) => a.id === n.id);
  if (files.length && status?.status !== 'done') out.push(vf(`openspec status: артефакт в статусе ${status?.status}`, `${changeDir(ctx)}/${n.outputPath}`));
  // openspec validate осмыслен, когда в change есть дельты specs/ (артефакт схемы, пишущий в specs/).
  const specsNode = ctx.graph.find((x) => x.outputPath.startsWith('specs/'));
  const specsReady = !!specsNode && (n.id === specsNode.id || st(ctx).spec.artifacts[specsNode.id]?.status === 'accepted');
  if (files.length && specsReady) {
    const v = await ctx.os.validate(st(ctx).change);
    if (!v.valid) {
      const errors = v.issues.filter((i) => i.level === 'ERROR');
      for (const i of errors.length ? errors : v.issues) out.push(vf(`openspec validate --strict: ${i.message}`, `${changeDir(ctx)}/${i.path}`));
    }
  }
  if (ctx.tracked.has(n.id) && files.length && !(await ctx.os.applyTasks(st(ctx).change)).length) {
    out.push(vf(`openspec instructions apply: в ${n.outputPath} не найдено ни одной задачи-чекбокса`, `${changeDir(ctx)}/${n.outputPath}`));
  }
  return out;
}

type GateDecision = { kind: 'accept' } | { kind: 'revise'; findings: Finding[] } | { kind: 'self' };

function filesOf(ctx: Ctx, n: ArtifactNode): string[] {
  return artifactFiles(changeDirAbs(ctx), n.outputPath).map((f) => `${changeDir(ctx)}/${f}`);
}

function humanFinding(ctx: Ctx, n: ArtifactNode, problem: string, requiredChange?: string): Finding {
  return synthetic(ctx, `artifact:${n.id}`, 0, 'human', {
    problem,
    location: filesOf(ctx, n)[0] ?? `${changeDir(ctx)}/${n.outputPath}`,
    evidence: 'решение человека',
    requiredChange,
  });
}

function showArtifact(ctx: Ctx, n: ArtifactNode): void {
  for (const f of filesOf(ctx, n)) {
    const lines = readFileSync(join(ctx.wt, f), 'utf8').split('\n');
    console.log(c.bold(`\n─── ${f} (${lines.length} строк) ───`));
    console.log(lines.slice(0, 150).join('\n') + (lines.length > 150 ? c.gray(`\n… ещё ${lines.length - 150} строк`) : ''));
  }
}

/**
 * Твоё ревью артефакта после PASS ревьюера: сначала отложенные вопросы по нему (выбор
 * из вариантов), затем решение — принять и перейти к следующему, вернуть автору, исправить самому.
 */
async function artifactGate(ctx: Ctx, n: ArtifactNode, snap: string, round: number): Promise<GateDecision> {
  const s = st(ctx);
  const pending = s.spec.questions.filter((q) => !q.answer && q.artifact === n.id);
  if (pending.length) {
    log.info(c.bold(`Вопросы по «${n.id}» (${pending.length}): выбери вариант стрелками`));
    const answered: Finding[] = [];
    for (const q of pending) {
      const { answer, discussion } = await ctx.human.question(q, discussFor(ctx, q, q));
      q.answer = answer;
      s.decisions.push({ at: now(), gate: `question:${n.id}`, decision: answer, comment: questionComment(q.question, discussion) });
      answered.push(humanFinding(ctx, n, questionDecision(q.question, answer, discussion), 'Отрази решение в артефакте и согласуй с ним остальные разделы'));
    }
    ctx.store.save();
    log.info('ответы уходят spec-author → правка → ревью → снова твоё ревью');
    return { kind: 'revise', findings: answered };
  }
  const next = ctx.graph[ctx.graph.indexOf(n) + 1];
  const loop = `artifact:${n.id}`;
  const logged = s.findings.filter((f) => f.step === loop && f.status === 'logged');
  const waived = s.findings.filter((f) => f.step === loop && f.status === 'waived');
  for (;;) {
    const k = await ctx.human.select({
      title: `Твоё ревью артефакта «${n.id}»`,
      context: [
        `файлы: ${filesOf(ctx, n).join(', ')}`,
        `каталог: ${changeDirAbs(ctx)}`,
        `раундов spec-author ↔ spec-reviewer: ${round} · snapshot ${short(snap)}`,
        ...logged.map((f) => `журнал ${f.severity}: ${f.id} ${oneLine(f.problem, 110)}`),
        ...waived.map((f) => `снято waiver: ${f.id} ${oneLine(f.problem, 80)} — ${f.waiver?.reason}`),
      ],
      options: [
        { key: 'accept', label: next ? `Принять «${n.id}» и перейти к «${next.id}»` : `Принять «${n.id}» — дальше сквозное ревью`, description: 'фиксируется принятый snapshot; правка позже потребует повторного ревью' },
        { key: 'revise', label: 'Вернуть spec-author с замечанием', description: 'замечание уйдёт автору как находка major, затем ревьюер и снова твоё решение' },
        { key: 'self', label: 'Исправлю сам, затем ревьюер перепроверит', description: 'правишь файлы в своём редакторе или сессии gigacode' },
        { key: 'show', label: 'Показать артефакт здесь', description: 'вывести файлы в терминал и вернуться к выбору' },
        { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)' },
      ],
      recommended: 'accept',
      rationale: `spec-reviewer дал PASS на текущей редакции${logged.length ? `; ${logged.length} minor/nit — только в журнале` : ', замечаний нет'}`,
    });
    if (k === 'show') {
      showArtifact(ctx, n);
      continue;
    }
    if (k === 'accept') {
      s.decisions.push({ at: now(), gate: `artifact:${n.id}`, decision: 'accepted', comment: short(snap) });
      ctx.store.save();
      return { kind: 'accept' };
    }
    if (k === 'stop') throw new Blocked(`остановлено человеком на ревью артефакта ${n.id}`);
    if (k === 'self') {
      if (await ctx.human.waitForEdit(filesOf(ctx, n).map((f) => join(ctx.wt, f)))) return { kind: 'self' };
      continue;
    }
    const comment = await ctx.human.text(`Замечание к «${n.id}» для spec-author`, 'уточни формулировки по рубрике');
    s.decisions.push({ at: now(), gate: `artifact:${n.id}`, decision: 'revise', comment });
    return { kind: 'revise', findings: [humanFinding(ctx, n, `Замечание человека: ${comment}`)] };
  }
}

type Exhausted = { action: 'continue'; toFix: Finding[]; reviewOnly: boolean } | { action: 'gate' };

/** Автоматические раунды артефакта кончились: что дальше — решаешь ты. */
async function artifactExhausted(ctx: Ctx, n: ArtifactNode, round: number, toFix: Finding[], history: string[][]): Promise<Exhausted> {
  const validatorOnly = toFix.length > 0 && toFix.every((f) => f.source === 'validator');
  const reviewerFs = toFix.filter((f) => f.source === 'spec-reviewer' || f.source === 'inject');
  const disputed = reviewerFs.length > 0 && reviewerFs.every((f) => f.response?.resolution === 'disputed');
  const repeated = exhaustedBefore(ctx, `exhausted:${n.id}`);
  const [recommended, rationale] = repeated >= 2
    ? (['stop', `лимит исчерпан уже ${repeated + 1}-й раз — продление не помогает, нужен разбор человеком`] as const)
    : validatorOnly
    ? (['hint', 'не проходит детерминированная валидация OpenSpec — автору нужен точный ориентир'] as const)
    : disputed
      ? (['waive', 'автор оспорил все оставшиеся находки с доказательствами — спор решаешь ты'] as const)
      : stuck(history)
        ? (['hint', 'одни и те же находки два раунда подряд — автор не сходится без твоего ориентира'] as const)
        : (['more', 'находки меняются от раунда к раунду — автор сходится'] as const);
  const ch = talk(
    ctx,
    `exhausted:${n.id}`,
    ['spec-reviewer', 'spec-author'],
    filesOf(ctx, n),
    {
      title: `Артефакт «${n.id}»: ${round} автоматических раунда без PASS`,
      context: toFix.map((f) => `${f.id} [${f.severity}] ${oneLine(f.problem, 110)}${f.response ? ` — автор: ${f.response.resolution}` : ''}`),
      options: [
        { key: 'more', label: 'Ещё раунд spec-author с теми же находками', description: 'лимит продлевается на один раунд' },
        { key: 'hint', label: 'Дать указание spec-author и продолжить', description: 'твой текст уйдёт автору как находка major' },
        { key: 'self', label: 'Исправлю сам, затем ревьюер перепроверит' },
        ...(validatorOnly ? [] : [{ key: 'waive', label: 'Снять оставшиеся находки с причиной (waiver)', description: 'waiver пишется в state.json и попадёт в отчёт приёмки' }]),
        { key: 'show', label: 'Показать артефакт здесь' },
        { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)' },
      ],
      recommended,
      rationale,
      ...modePick(ctx, recommended),
    },
    { exhausted: true },
  );
  for (;;) {
    const k = await ask(ctx, ch);
    if (k === 'show') {
      showArtifact(ctx, n);
      continue;
    }
    st(ctx).decisions.push({ at: now(), gate: `exhausted:${n.id}`, decision: k, comment: talkComment(ch) });
    ctx.store.save();
    const note = talkNote(ch);
    const talked = note ? [humanFinding(ctx, n, note)] : [];
    if (k === 'more') return { action: 'continue', toFix: [...toFix, ...talked], reviewOnly: false };
    if (k === 'stop') throw new Blocked(`артефакт ${n.id}: остановлено человеком после ${round} раундов`);
    if (k === 'self') {
      if (await ctx.human.waitForEdit(filesOf(ctx, n).map((f) => join(ctx.wt, f)))) return { action: 'continue', toFix: [], reviewOnly: true };
      continue;
    }
    if (k === 'hint') {
      const text = await ctx.human.text(`Указание для spec-author по «${n.id}»`, 'Сосредоточься на находках ревьюера; если находка неверна — ответь disputed с доказательством');
      return { action: 'continue', toFix: [...toFix, humanFinding(ctx, n, `Указание человека: ${text}`), ...talked], reviewOnly: false };
    }
    const reason = await ctx.human.text('Причина waiver', 'принято человеком: замечание не блокирует артефакт');
    waive(ctx, reviewerFs, reason, snapshotOf(ctx, n));
    return { action: 'gate' };
  }
}

/**
 * Петля одного артефакта: spec-author → валидация → snapshot → spec-reviewer, REVISE —
 * автоматически до artifactRounds раундов, дальше решаешь ты. После PASS — твоё ревью.
 */
async function artifactLoop(ctx: Ctx, n: ArtifactNode, seed: Finding[], opts: { reviewFirst?: boolean } = {}): Promise<void> {
  const next = ctx.graph[ctx.graph.indexOf(n) + 1];
  const scope: PassScope = {
    loop: `artifact:${n.id}`,
    label: `принять «${n.id}» как есть → ${next ? `«${next.id}»` : 'сквозное ревью'}`,
    // Без чистой валидации OpenSpec не пройдут freeze и archive — такой артефакт дальше не пускаем.
    check: async () => {
      const p = await validationProblems(ctx, n);
      return p.length ? `ошибки валидации OpenSpec (${p.length}): без openspec validate --strict не пройдут freeze и archive` : undefined;
    },
  };
  await passLoop(ctx, scope, () => artifactRounds(ctx, n, seed, opts), (reason) => {
    const snap = snapshotOf(ctx, n);
    closeLoop(ctx, scope, reason, snap);
    Object.assign(st(ctx).spec.artifacts[n.id]!, { status: 'accepted', snapshot: snap, passedBy: 'human' });
    ctx.store.save();
    log.info(c.yellow(`«${n.id}» принят как есть решением человека · snapshot ${short(snap)}`));
  });
}

async function artifactRounds(ctx: Ctx, n: ArtifactNode, seed: Finding[], opts: { reviewFirst?: boolean }): Promise<void> {
  const s = st(ctx);
  const loop = `artifact:${n.id}`;
  const a = (s.spec.artifacts[n.id] ??= { status: 'pending', rounds: 0 });
  a.status = 'pending';
  delete a.passedBy;
  ctx.store.save();
  const max = ctx.policy.limits.artifactRounds;
  let budget = max;
  let toFix = seed;
  let session: string | undefined;
  let reviewOnly = !!opts.reviewFirst;
  const history: string[][] = [];
  /** Ревью человеком — после PASS ревьюера или без spec-reviewer; true — артефакт принят. */
  const toHuman = async (snap: string, round: number): Promise<boolean> => {
    const g = await artifactGate(ctx, n, snap, round);
    if (g.kind === 'accept') {
      a.status = 'accepted';
      a.snapshot = snap;
      ctx.store.save();
      log.info(c.green(`«${n.id}» принят тобой · snapshot ${short(snap)}`));
      return true;
    }
    if (g.kind === 'self') reviewOnly = true;
    else toFix = g.findings;
    budget = round + max;
    return false;
  };
  for (let round = 1; ; round++) {
    a.rounds++;
    ctx.store.save();
    log.loopOpen(`артефакт ${n.id}`, round, Math.max(budget, round));
    const before = artifactText(changeDirAbs(ctx), n.outputPath);

    if (reviewOnly) {
      log.step('артефакт уже написан (существующий change, твоя правка или изменённый upstream): сначала ревью, без генерации');
    } else {
      ctx.store.setStep(`spec:${n.id}:generate`);
      const instructions = await ctx.os.instructions(n.id, s.change);
      const prompt = authorPrompt(base(ctx), {
        id: n.id,
        generates: n.outputPath,
        round,
        max: Math.max(budget, round),
        instructions,
        upstream: upstreamOf(ctx, n),
        rubric: loadRubric(ctx.root, n.id),
        findings: toFix,
        exists: artifactFiles(changeDirAbs(ctx), n.outputPath).length > 0,
        tracked: ctx.tracked.has(n.id),
      });
      const res = await callRole(ctx, 'spec-author', prompt, { kind: 'author', artifact: n.id, generates: n.outputPath, changeDir: changeDir(ctx), round }, {
        label: `spec-${n.id}-r${a.rounds}-author`,
        resume: session,
      });
      session = res.sessionId;
      const j = applyResponses(ctx, loop, res.text);
      consume(ctx, toFix);
      if (Array.isArray(j?.['questions'])) collectQuestions(ctx, 'spec-author', n.id, j!['questions'] as QuestionItem[]);
    }
    const wasReviewOnly = reviewOnly;
    reviewOnly = false;

    ctx.store.setStep(`spec:${n.id}:validate`);
    const vf = await validateArtifact(ctx, n, loop, round);
    if (vf.length) {
      log.verdict('REVISE', `валидатор: ${vf.length} ошибок`, round < budget ? `назад к spec-author, раунд ${round + 1}` : 'автоматические раунды кончились');
      ctx.store.loop(loop, round, 'REVISE', 'validator');
      log.loopClose('REVISE (валидатор)');
      toFix = vf;
      history.push(vf.map((f) => f.problem));
    } else {
      log.step('детерминированная валидация пройдена (файлы, openspec status/validate, формат)');
      const snap = snapshotOf(ctx, n);
      log.step(`snapshot артефакта ${short(snap)}`);
      if (!on(ctx, 'spec-reviewer')) {
        ctx.store.loop(loop, round, 'SKIPPED', 'spec-reviewer выключен');
        log.verdict('SKIPPED', 'spec-reviewer выключен в настройках run', 'твоё ревью артефакта');
        log.loopClose(`«${n.id}» без ревью spec-reviewer`);
        if (await toHuman(snap, round)) return;
        continue;
      }
      const instrPath = join(ctx.contextsDir, `instructions-${n.id}.json`);
      writeFileSync(instrPath, JSON.stringify(await ctx.os.instructions(n.id, s.change), null, 2));
      let fixDiffPath: string | undefined;
      if (round > 1 || wasReviewOnly) {
        const prevPath = join(ctx.contextsDir, `${n.id}-r${a.rounds}-before.md`);
        const curPath = join(ctx.contextsDir, `${n.id}-r${a.rounds}-after.md`);
        writeFileSync(prevPath, before);
        writeFileSync(curPath, artifactText(changeDirAbs(ctx), n.outputPath));
        fixDiffPath = join(ctx.contextsDir, `${n.id}-r${a.rounds}-fix.diff`);
        writeFileSync(fixDiffPath, (await diffNoIndex(ctx.wt, prevPath, curPath)) || '(без изменений)\n');
      }

      ctx.store.setStep(`spec:${n.id}:review`);
      const rubric = loadRubric(ctx.root, n.id);
      const files = artifactFiles(changeDirAbs(ctx), n.outputPath);
      let review = await callReviewer(
        ctx,
        'spec-reviewer',
        specReviewPrompt(base(ctx), {
          id: n.id,
          files,
          upstream: upstreamOf(ctx, n),
          rubric,
          snapshotId: snap,
          round,
          max: Math.max(budget, round),
          prior: [...openFindings(ctx, loop), ...s.findings.filter((f) => f.step === loop && f.status === 'waived')],
          fixDiffPath,
          instructionsPath: instrPath,
        }),
        { kind: 'spec-review', artifact: n.id, changeDir: changeDir(ctx), snapshotId: snap, round, checks: rubric.mandatory, target: n.id },
        { role: 'spec-reviewer', target: n.id, snapshotId: snap, round, mandatoryChecks: rubric.mandatory },
        `spec-${n.id}-r${a.rounds}-review`,
      );
      if (snapshotOf(ctx, n) !== snap) throw new Blocked(`артефакт ${n.id} изменился во время ревью — вердикт к другой редакции`);
      const loc = `${changeDir(ctx)}/${files[0] ?? n.outputPath}:1`;
      if (ctx.inject.repeat(`artifact-stuck:${n.id}`, max)) review = injectRevise(review, loc, round, 'INJ-STUCK');
      else if (ctx.inject.take(`artifact-revise:${n.id}`)) review = injectRevise(review, loc, round);
      review = injectBlocked(ctx, loop, review);

      const d = honorWaivers(ctx, loop, snap, decide(review, 'spec'));
      await applyReview(ctx, loop, round, review, d);
      collectQuestions(
        ctx,
        'spec-reviewer',
        n.id,
        d.human.map((f) => ({
          question: f.problem,
          why: f.evidence,
          options: [{ label: f.requiredChange ? `Как предлагает ревьюер: ${f.requiredChange}` : 'Как предлагает ревьюер' }, { label: 'Оставить как есть' }],
          recommended: 0,
          rationale: 'ревьюер пометил это как продуктовую развилку и предложил решение',
          artifact: f.artifact,
        })),
      );
      ctx.store.loop(loop, round, d.verdict, d.reason);
      const counts = countBySeverity(review.findings);

      if (d.verdict === 'BLOCKED') {
        log.verdict('BLOCKED', d.reason, 'решаешь ты');
        log.loopClose('BLOCKED');
        const ch = talk(ctx, `blocked:${n.id}`, ['spec-reviewer', 'spec-author'], filesOf(ctx, n), {
          title: `spec-reviewer не может проверить «${n.id}»`,
          context: [d.reason],
          options: [
            { key: 'context', label: 'Дать недостающий контекст и продолжить', description: 'текст попадёт в уточнения intent — его увидят автор и ревьюер' },
            { key: 'self', label: 'Исправлю артефакт сам, затем ревьюер перепроверит' },
            { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)' },
          ],
          recommended: 'context',
          rationale: 'ревьюеру не хватает контекста — дать его может только человек',
        });
        const k = await ask(ctx, ch);
        s.decisions.push({ at: now(), gate: `blocked:${n.id}`, decision: k, comment: talkComment(ch) });
        if (k === 'stop') throw new Blocked(`артефакт ${n.id}: ${d.reason}`);
        if (k === 'self') {
          if (await ctx.human.waitForEdit(filesOf(ctx, n).map((f) => join(ctx.wt, f)))) reviewOnly = true;
        } else {
          const text = await ctx.human.text('Недостающий контекст', 'используй intent и код репозитория как единственный источник');
          s.intent.clarifications.push({ question: `контекст для ${n.id}: ${d.reason}`, answer: text });
          const note = talkNote(ch);
          toFix = [humanFinding(ctx, n, `Контекст от человека: ${text}`), ...(note ? [humanFinding(ctx, n, note)] : [])];
        }
        budget = round + max;
        continue;
      }

      if (d.verdict === 'PASS') {
        log.verdict('PASS', counts, 'твоё ревью артефакта');
        log.loopClose(`ревьюер принял «${n.id}» на раунде ${round}`);
        if (await toHuman(snap, round)) return;
        continue;
      }

      log.verdict('REVISE', counts, round < budget ? `назад к spec-author, раунд ${round + 1}` : 'автоматические раунды кончились');
      log.loopClose('REVISE');
      toFix = stored(ctx, loop, d.blocking);
      history.push(toFix.map((f) => f.id));
    }

    if (round < budget) continue;
    const ex = await artifactExhausted(ctx, n, round, toFix, history);
    budget = round + 1;
    if (ex.action === 'continue') {
      toFix = ex.toFix;
      reviewOnly = ex.reviewOnly;
      continue;
    }
    const snap = snapshotOf(ctx, n);
    const g = await artifactGate(ctx, n, snap, round);
    if (g.kind === 'accept') {
      a.status = 'accepted';
      a.snapshot = snap;
      ctx.store.save();
      log.info(c.green(`«${n.id}» принят тобой с waiver · snapshot ${short(snap)}`));
      return;
    }
    if (g.kind === 'self') reviewOnly = true;
    else toFix = g.findings;
    budget = round + max;
  }
}

/** Повторное принятие после правок: исправить указанные артефакты, переревьюить устаревшие. */
async function reaccept(ctx: Ctx, groups: Map<string, Finding[]>): Promise<void> {
  for (const n of ctx.graph) {
    const seed = groups.get(n.id);
    const a = st(ctx).spec.artifacts[n.id];
    if (seed?.length) await artifactLoop(ctx, n, seed);
    else if (a?.status === 'accepted' && snapshotOf(ctx, n) !== a.snapshot) await artifactLoop(ctx, n, [], { reviewFirst: true });
  }
}

function artifactOfLocation(ctx: Ctx, location: string): string | undefined {
  const rel = location.replace(/:\d+.*$/, '').replace(`${changeDir(ctx)}/`, '');
  return ctx.graph.find((n) => matchesAny(rel, [n.outputPath]))?.id;
}

/** Сквозное ревью: свежий spec-reviewer по всему пакету; после лимита раундов решаешь ты. */
async function holisticLoop(ctx: Ctx): Promise<void> {
  if (!on(ctx, 'spec-reviewer')) {
    Object.assign(st(ctx).spec, { holisticPassed: true, holisticDigest: currentDigest(ctx) });
    ctx.store.loop('holistic', 1, 'SKIPPED', 'spec-reviewer выключен');
    log.step('сквозное ревью пропущено: spec-reviewer выключен в настройках run');
    return;
  }
  const scope: PassScope = { loop: 'holistic', label: 'снять находки сквозного ревью → согласование спеки' };
  await passLoop(ctx, scope, () => holisticRounds(ctx), (reason) => {
    const snap = currentDigest(ctx);
    closeLoop(ctx, scope, reason, snap);
    Object.assign(st(ctx).spec, { holisticPassed: true, holisticDigest: snap });
    ctx.store.save();
  });
}

async function holisticRounds(ctx: Ctx): Promise<void> {
  const s = st(ctx);
  s.spec.holisticPassed = false;
  const max = ctx.policy.limits.holisticRounds;
  let budget = max;
  const history: string[][] = [];
  for (let round = 1; ; round++) {
    log.loopOpen('сквозное ревью спеки', round, Math.max(budget, round));
    ctx.store.setStep('spec:holistic:review');
    const snap = currentDigest(ctx);
    log.step(`digest пакета ${short(snap)}`);
    const rubric = loadRubric(ctx.root, 'holistic');
    const reqs = indexRequirements(changeDirAbs(ctx), changeDir(ctx));
    const artifacts = ctx.graph.map((n) => ({ id: n.id, files: artifactFiles(changeDirAbs(ctx), n.outputPath) }));
    let review = await callReviewer(
      ctx,
      'spec-reviewer',
      holisticPrompt(base(ctx), { artifacts, reqs, rubric, snapshotId: snap, round, max: Math.max(budget, round), prior: openFindings(ctx, 'holistic') }),
      { kind: 'holistic', changeDir: changeDir(ctx), snapshotId: snap, round, checks: rubric.mandatory, target: 'change' },
      { role: 'spec-reviewer', target: 'change', snapshotId: snap, round, mandatoryChecks: rubric.mandatory },
      `spec-holistic-r${round}`,
    );
    if (ctx.inject.take('holistic-revise')) {
      review = injectRevise(review, `${changeDir(ctx)}/design.md:1`, round);
      review.findings.at(-1)!.artifact = 'design';
    }
    review = injectBlocked(ctx, 'holistic', review);
    const d = honorWaivers(ctx, 'holistic', snap, decide(review, 'spec'));
    await applyReview(ctx, 'holistic', round, review, d);
    collectQuestions(ctx, 'spec-reviewer', 'proposal', d.human.map((f) => ({ question: f.problem, why: f.evidence, options: [{ label: f.requiredChange ?? 'Как предлагает ревьюер' }, { label: 'Оставить как есть' }], recommended: 0, rationale: 'решение, которое предложил ревьюер', artifact: f.artifact ?? artifactOfLocation(ctx, f.location) })));
    ctx.store.loop('holistic', round, d.verdict, d.reason);
    if (d.verdict === 'BLOCKED') {
      log.verdict('BLOCKED', d.reason, 'решаешь ты');
      log.loopClose('BLOCKED');
      await onBlocker(ctx, {
        gate: 'blocked:holistic',
        title: 'Сквозное ревью: spec-reviewer не может проверить пакет',
        reason: `сквозное ревью: ${d.reason}`,
        roles: ['spec-reviewer', 'spec-author'],
        files: ctx.graph.flatMap((n) => filesOf(ctx, n)),
      });
      budget = Math.max(budget, round + 1);
      continue;
    }
    if (d.verdict === 'PASS') {
      s.spec.holisticPassed = true;
      s.spec.holisticDigest = snap;
      ctx.store.save();
      log.verdict('PASS', countBySeverity(review.findings), 'пакет спеки готов к согласованию');
      log.loopClose('сквозное ревью пройдено');
      return;
    }
    const blocking = stored(ctx, 'holistic', d.blocking);
    history.push(blocking.map((f) => f.id));
    const groups = new Map<string, Finding[]>();
    for (const f of blocking) {
      const id = (f.artifact && ctx.graph.some((n) => n.id === f.artifact) ? f.artifact : artifactOfLocation(ctx, f.location)) ?? 'proposal';
      groups.set(id, [...(groups.get(id) ?? []), f]);
    }
    log.verdict('REVISE', countBySeverity(review.findings), `исправить: ${[...groups.keys()].join(', ')}; downstream — повторное ревью`);
    log.loopClose('REVISE → петли артефактов');
    if (round >= budget) {
      const files = ctx.graph.flatMap((n) => filesOf(ctx, n));
      const recommended = exhaustedBefore(ctx, 'exhausted:holistic') >= 2 ? 'stop' : stuck(history) ? 'waive' : 'more';
      const ch = talk(ctx, 'exhausted:holistic', ['spec-reviewer', 'spec-author'], files, {
        title: `Сквозное ревью: ${round} раунда без PASS`,
        context: blocking.map((f) => `${f.id} [${f.severity}] → ${f.artifact ?? artifactOfLocation(ctx, f.location) ?? '?'}: ${oneLine(f.problem, 110)}`),
        options: [
          { key: 'more', label: 'Ещё раунд: исправить артефакты по находкам', description: 'петли артефактов с твоим ревью, затем сквозное ревью' },
          { key: 'waive', label: 'Снять оставшиеся находки сквозного ревью с причиной (waiver)' },
          { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)' },
        ],
        recommended,
        ...modePick(ctx, recommended),
        rationale:
          exhaustedBefore(ctx, 'exhausted:holistic') >= 2
            ? 'лимит исчерпан уже не первый раз — продление не помогает, нужен разбор человеком'
            : stuck(history)
              ? 'те же находки повторяются после исправлений — вероятно, спорные; реши сам'
              : 'находки меняются — пакет сходится',
      }, { exhausted: true });
      const k = await ask(ctx, ch);
      s.decisions.push({ at: now(), gate: 'exhausted:holistic', decision: k, comment: talkComment(ch) });
      if (k === 'stop') throw new Blocked(`сквозное ревью: остановлено человеком после ${round} раундов`);
      if (k === 'waive') {
        waive(ctx, blocking, await ctx.human.text('Причина waiver', 'принято человеком: не блокирует реализацию'), snap);
        s.spec.holisticPassed = true;
        s.spec.holisticDigest = snap;
        ctx.store.save();
        return;
      }
      const note = talkNote(ch);
      if (note) for (const [id, fs] of groups) fs.push(humanFinding(ctx, node(ctx, id), note));
      budget = round + 1;
    }
    // Находки остаются open: следующий раунд сквозного ревью закроет их или повторит.
    await reaccept(ctx, groups);
  }
}

async function stageClarify(ctx: Ctx): Promise<void> {
  if (!st(ctx).options.clarify) return;
  const written = ctx.graph.filter((n) => artifactFiles(changeDirAbs(ctx), n.outputPath).length);
  if (written.length) {
    log.step(`change уже содержит артефакты (${written.map((n) => n.id).join(', ')}) — уточнение intent пропущено`);
    return;
  }
  log.phase('ФАЗА СПЕКИ · уточнение intent');
  const scope: PassScope = { loop: 'clarify', label: 'пропустить уточнения intent → фаза спеки' };
  await passLoop(ctx, scope, () => clarifyQuestions(ctx), (reason) => closeLoop(ctx, scope, reason, ''));
}

async function clarifyQuestions(ctx: Ctx): Promise<void> {
  ctx.store.setStep('clarify');
  const res = await callRole(ctx, 'spec-author', clarifyPrompt(base(ctx)), { kind: 'clarify' }, { label: 'clarify', readOnly: true });
  const j = extractJson(res.text) as { questions?: QuestionItem[] } | undefined;
  const qs = (j?.questions ?? []).filter((q) => q.question);
  if (!qs.length) log.step('уточнений не требуется');
  for (const [i, q] of qs.entries()) {
    const options = (q.options ?? []).map((o) => (typeof o === 'string' ? { label: o } : { label: String(o.label ?? ''), description: o.description })).filter((o) => o.label);
    const { answer, discussion } = await ctx.human.question({ ...q, options }, discussFor(ctx, { id: `clarify-${i + 1}`, from: 'spec-author', options }));
    st(ctx).intent.clarifications.push({ question: q.question, answer, ...(discussion.length ? { discussion } : {}) });
    st(ctx).decisions.push({ at: now(), gate: 'clarify', decision: answer, comment: questionComment(q.question, discussion) });
  }
  ctx.store.save();
}

async function stageSpec(ctx: Ctx): Promise<void> {
  log.phase(`ФАЗА СПЕКИ · артефакты по графу схемы: ${ctx.graph.map((n) => n.id).join(' → ')}`);
  for (const n of ctx.graph) {
    const a = st(ctx).spec.artifacts[n.id];
    if (a?.status === 'accepted' && a.snapshot === snapshotOf(ctx, n)) continue;
    // Уже написанный артефакт (существующий change, resume) сначала ревьюится, а не пишется заново.
    await artifactLoop(ctx, n, [], { reviewFirst: artifactFiles(changeDirAbs(ctx), n.outputPath).length > 0 });
  }
  log.info(c.green('все артефакты приняты тобой → сквозное ревью новым экземпляром spec-reviewer'));
  if (!st(ctx).spec.holisticPassed || st(ctx).spec.holisticDigest !== currentDigest(ctx)) await holisticLoop(ctx);
}

/** Условия freeze: принятые артефакты на текущих snapshot, validate --strict, сквозное ревью. */
async function freezeProblems(ctx: Ctx): Promise<string[]> {
  const s = st(ctx);
  const out: string[] = [];
  for (const n of ctx.graph) {
    const a = s.spec.artifacts[n.id];
    if (a?.status !== 'accepted') out.push(`«${n.id}» не принят`);
    else if (a.snapshot !== snapshotOf(ctx, n)) out.push(`«${n.id}» изменён после принятия — ревью устарело`);
  }
  const v = await ctx.os.validate(s.change);
  if (!v.valid) out.push(`openspec validate --strict: ${v.issues.map((i) => i.message).join('; ')}`);
  if (on(ctx, 'spec-reviewer') && (!s.spec.holisticPassed || s.spec.holisticDigest !== currentDigest(ctx))) out.push('сквозное ревью не пройдено на текущей редакции пакета');
  return out;
}

/** Согласование и freeze (/spec-approve): проходит только при выполненных условиях. */
async function stageApproval(ctx: Ctx): Promise<void> {
  const s = st(ctx);
  for (;;) {
    log.phase('СОГЛАСОВАНИЕ И FREEZE СПЕКИ');
    const pending = s.spec.questions.filter((q) => !q.answer);
    if (pending.length) {
      const groups = new Map<string, Finding[]>();
      for (const q of pending) {
        const { answer, discussion } = await ctx.human.question(q, discussFor(ctx, q, q));
        q.answer = answer;
        s.decisions.push({ at: now(), gate: 'approval:question', decision: answer, comment: questionComment(q.question, discussion) });
        const n = node(ctx, q.artifact) ?? ctx.graph[0]!;
        groups.set(n.id, [...(groups.get(n.id) ?? []), humanFinding(ctx, n, questionDecision(q.question, answer, discussion), 'Отрази решение в артефакте')]);
      }
      ctx.store.save();
      await reaccept(ctx, groups);
      await holisticLoop(ctx);
      continue;
    }
    const problems = await freezeProblems(ctx);
    if (problems.length) {
      for (const p of problems) log.warn(`freeze невозможен: ${p}`);
      log.info('устаревшие артефакты уходят на повторное ревью, затем сквозное ревью');
      await reaccept(ctx, new Map());
      if (!s.spec.holisticPassed || s.spec.holisticDigest !== currentDigest(ctx)) await holisticLoop(ctx);
      if ((await freezeProblems(ctx)).length) throw new Blocked(`freeze невозможен: ${problems.join('; ')}`);
      continue;
    }
    const waived = s.findings.filter((f) => f.status === 'waived' && (f.step.startsWith('artifact:') || f.step === 'holistic'));
    const logged = s.findings.filter((f) => f.status === 'logged' && (f.step.startsWith('artifact:') || f.step === 'holistic'));
    const k = await ctx.human.select({
      title: specRun(ctx) ? 'Заморозить спеку?' : 'Заморозить спеку и запустить apply?',
      context: [
        ...ctx.graph.map((n) => `✓ ${n.id.padEnd(10)} раундов ${s.spec.artifacts[n.id]!.rounds} · ${short(s.spec.artifacts[n.id]!.snapshot ?? '')} · ${filesOf(ctx, n).join(', ')}`),
        `${on(ctx, 'spec-reviewer') ? 'сквозное ревью PASS' : 'сквозное ревью выключено (spec-reviewer)'} · openspec validate --strict чист · digest ${short(currentDigest(ctx))}`,
        ...(waived.length ? [`снято waiver: ${waived.map((f) => f.id).join(', ')}`] : []),
        ...(logged.length ? [`minor/nit в журнале: ${logged.length}`] : []),
      ],
      options: [
        specRun(ctx)
          ? { key: 'freeze', label: 'Заморозить и завершить run', description: 'implementer выключен: спека коммитится в ветку, change остаётся активным для кода' }
          : { key: 'freeze', label: 'Заморозить и перейти к apply', description: 'дальше конвейер меняет только код и тесты в рамках контракта' },
        { key: 'revise', label: 'Вернуть артефакт на доработку', description: 'выбрать артефакт и дать замечание; ниже по графу — повторное ревью' },
        { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)' },
      ],
      recommended: 'freeze',
      rationale: `все условия freeze выполнены: артефакты приняты тобой на текущих редакциях, ${on(ctx, 'spec-reviewer') ? 'сквозное ревью и validate чистые' : 'validate чист'}`,
    });
    if (k === 'freeze') {
      s.decisions.push({ at: now(), gate: 'approval', decision: 'approved' });
      ctx.store.save();
      return;
    }
    if (k === 'stop') {
      s.decisions.push({ at: now(), gate: 'approval', decision: 'stopped' });
      throw new Blocked('остановлено человеком на согласовании спеки');
    }
    const target = await ctx.human.select({
      title: 'Какой артефакт вернуть?',
      options: ctx.graph.map((n) => ({ key: n.id, label: n.id, description: filesOf(ctx, n).join(', ') })),
      recommended: ctx.graph[0]!.id,
      rationale: 'правка выше по графу затрагивает все следующие артефакты',
    });
    const n = node(ctx, target);
    const comment = await ctx.human.text(`Замечание к «${n.id}»`, 'уточни формулировки по рубрике');
    s.decisions.push({ at: now(), gate: 'approval', decision: 'revise', comment: `${n.id}: ${comment}` });
    await reaccept(ctx, new Map([[n.id, [humanFinding(ctx, n, `Замечание человека: ${comment}`)]]]));
    await holisticLoop(ctx);
  }
}

function currentDigest(ctx: Ctx): string {
  return specDigest(changeDirAbs(ctx), ctx.graph.map((n) => n.outputPath));
}

function verifyFreeze(ctx: Ctx): void {
  const fr = st(ctx).spec.freeze;
  if (!fr) throw new Blocked('спека не заморожена');
  const d = currentDigest(ctx);
  if (d !== fr.digest) throw new Blocked(`замороженная спека изменена: digest ${short(d)} ≠ ${short(fr.digest)} — возврат к фазе спеки`);
  log.step(`digest спеки сверен: ${short(d)}`);
}

async function stageFreeze(ctx: Ctx): Promise<void> {
  log.phase('FREEZE СПЕКИ');
  const digest = currentDigest(ctx);
  const commit = await commitAll(ctx.wt, `agentflow(${st(ctx).change}): спека согласована и заморожена ${short(digest)}`);
  st(ctx).spec.freeze = { digest, at: now(), commit };
  st(ctx).apply.base = commit;
  ctx.store.save();
  log.step(`digest ${short(digest)} · коммит ${commit.slice(0, 10)}`);
  log.info(specRun(ctx) ? 'implementer выключен: run только со спекой, apply, acceptance и финала нет' : 'дальше конвейер меняет только код и тесты в рамках утверждённого контракта');
}

// ───────────────────────────── фаза apply ─────────────────────────────

function requirements(ctx: Ctx): Requirement[] {
  return indexRequirements(changeDirAbs(ctx), changeDir(ctx));
}

function specFiles(ctx: Ctx): string[] {
  return ctx.graph.flatMap((n) => artifactFiles(changeDirAbs(ctx), n.outputPath).map((f) => `${changeDir(ctx)}/${f}`));
}

/** Изменённые файлы против ACL роли: защита второй линии поверх canUseTool. */
/** Незакоммиченные правки дерева run — в пределах ACL роли (или хотя бы одной из ролей). */
async function checkBoundary(ctx: Ctx, roleName: string | string[]): Promise<void> {
  const names = [roleName].flat();
  const sub = (g: string) => expandGlob(g, st(ctx).change, ctx.policy);
  const allowed = (p: string) =>
    names.some((n) => {
      const rp = ctx.policy.roles[n]!;
      return matchesAny(p, rp.write.map(sub)) && !matchesAny(p, (rp.denyWrite ?? []).map(sub));
    });
  const bad = treeChanges(await changedPaths(ctx.wt)).filter((p) => !allowed(p));
  if (bad.length) throw new Blocked(`${names.join(' / ')} изменил файлы вне своих полномочий: ${bad.join(', ')}`);
}

function recordGates(ctx: Ctx, gates: GateResult[]): void {
  for (const g of gates) st(ctx).gates.push({ op: g.op, ok: g.ok, exitCode: g.exitCode, step: g.step, logPath: g.logPath, at: g.at });
  ctx.store.save();
}

/** implementer + петля гейтов: красный → тот же implementer, ≤ gateAttempts на вызов. */
async function implementWithGates(
  ctx: Ctx,
  a: { batch: TaskBatch; round: number; max: number; toFix: Finding[]; failures: string[]; session?: string; label: string; loop: string },
): Promise<{ green: boolean; session: string; gates: GateResult[] }> {
  const rp = ctx.policy.roles['implementer']!;
  const fresh = !a.session;
  const reqs = requirements(ctx);
  const prompt = (gateOutput?: string) =>
    implementerPrompt(base(ctx), {
      batch: a.batch,
      round: a.round,
      max: a.max,
      reqs,
      specFiles: specFiles(ctx),
      write: rp.write,
      denyWrite: rp.denyWrite ?? [],
      shell: rp.shell,
      findings: gateOutput ? [] : a.toFix,
      failures: fresh ? a.failures : [],
      gateOutput,
      fresh: fresh && !gateOutput,
    });
  const meta: TaskMeta = { kind: 'implement', batchId: a.batch.id, round: a.round };
  let res = await callRole(ctx, 'implementer', prompt(), meta, { label: `${a.label}-impl`, resume: a.session });
  let session = res.sessionId;
  const j = applyResponses(ctx, a.loop, res.text);
  consume(ctx, a.toFix);
  if (j?.['status'] === 'NEEDS_SPEC_CHANGE') {
    const r = await onBlocker(ctx, {
      gate: `spec-change:${a.label}`,
      title: `${a.loop}: implementer просит изменить спеку`,
      reason: `implementer: спеку нужно изменить — ${String(j['specIssue'] ?? 'без описания')}`,
      roles: ['implementer', 'code-reviewer'],
      files: specFiles(ctx),
      retry: 'Дать указание implementer и повторить шаг',
      ask: 'Указание для implementer',
    });
    // Тот же раунд той же сессией: implementer получает указание человека как находку.
    const toFix = [
      synthetic(ctx, a.loop, a.round, 'human', { problem: `Указание человека: ${r.text}`, location: a.loop, evidence: 'решение человека' }),
      ...(r.note ? [synthetic(ctx, a.loop, a.round, 'human', { problem: r.note, location: a.loop, evidence: 'обсуждение решения' })] : []),
    ];
    return implementWithGates(ctx, { ...a, toFix, session: res.sessionId });
  }

  const attempts = ctx.policy.limits.gateAttempts;
  let gates: GateResult[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    ctx.store.setStep(`apply:${a.label}:gates:${attempt}`);
    await checkBoundary(ctx, 'implementer');
    log.step(`гейты ${ctx.policy.gates.batch.join(', ')} · попытка ${attempt}/${attempts}`);
    gates = await runGates(ctx.policy.gates.batch, {
      cwd: ctx.wt,
      policy: ctx.policy,
      logDir: ctx.gatesDir,
      step: `${a.label}-a${attempt}`,
      injectRed: attempt === 1 && ctx.inject.take(`gate-red:${a.batch.id}`),
    });
    recordGates(ctx, gates);
    if (gates.every((g) => g.ok)) {
      ctx.store.loop(`гейты:${a.batch.id}`, attempt, 'PASS');
      return { green: true, session, gates };
    }
    ctx.store.loop(`гейты:${a.batch.id}`, attempt, 'RED');
    if (attempt === attempts) break;
    log.verdict('RED', `красных гейтов: ${gates.filter((g) => !g.ok).length}`, `назад к implementer, попытка ${attempt + 1}/${attempts}`);
    res = await callRole(ctx, 'implementer', prompt(gatesSummary(gates)), meta, { label: `${a.label}-gatefix${attempt}`, resume: session });
    session = res.sessionId;
  }
  return { green: false, session, gates };
}

/** Отметить задачи в файле задач, как принято в OpenSpec; digest спеки галочки нормализует. */
function tickTasks(tasks: { done: boolean; file?: string; line?: number }[]): void {
  const byFile = new Map<string, number[]>();
  for (const t of tasks) if (t.done && t.file && t.line) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t.line]);
  for (const [file, lines] of byFile) {
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8').split('\n');
    for (const l of lines) if (src[l - 1] !== undefined) src[l - 1] = src[l - 1]!.replace(/^(\s*[-*]\s+)\[ \]/, '$1[x]');
    writeFileSync(file, src.join('\n'));
  }
}

/** Автоматические раунды батча или финала кончились: что дальше — решаешь ты. */
async function applyExhausted(
  ctx: Ctx,
  what: string,
  round: number,
  toFix: Finding[],
  history: string[][],
  gateFailed: boolean,
  files: string[],
): Promise<{ kind: 'more' | 'fresh'; hint?: string; note?: string }> {
  const repeated = exhaustedBefore(ctx, `exhausted:${what}`);
  const [recommended, rationale] = repeated >= 2
    ? (['stop', `лимит исчерпан уже ${repeated + 1}-й раз — смена условий не помогает, нужен разбор человеком`] as const)
    : gateFailed
    ? (['fresh', 'гейты красные после всех попыток — нужен свежий контекст и сводка провалов'] as const)
    : stuck(history)
      ? (['hint', 'одни и те же находки два раунда подряд — implementer не сходится без твоего ориентира'] as const)
      : (['more', 'находки меняются от раунда к раунду — implementer сходится'] as const);
  const ch = talk(ctx, `exhausted:${what}`, ['code-reviewer', 'implementer'], files, {
    title: `${what}: ${round} автоматических раунда без PASS`,
    context: toFix.map((f) => `${f.id} [${f.severity}] ${oneLine(f.problem, 110)}${f.response ? ` — implementer: ${f.response.resolution}` : ''}`),
    options: [
      { key: 'more', label: 'Ещё раунд той же сессией implementer', description: 'лимит продлевается на один раунд' },
      { key: 'fresh', label: 'Новый implementer со свежим контекстом и сводкой провалов' },
      { key: 'hint', label: 'Дать указание implementer и продолжить', description: 'твой текст уйдёт как находка major' },
      { key: 'spec', label: 'Вернуться к спеке', description: 'apply останавливается: спеку нужно изменить и согласовать заново' },
      { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)' },
    ],
    recommended,
    rationale,
  }, { exhausted: true });
  const k = await ask(ctx, ch);
  st(ctx).decisions.push({ at: now(), gate: `exhausted:${what}`, decision: k, comment: talkComment(ch) });
  ctx.store.save();
  const note = talkNote(ch);
  if (k === 'stop') throw new Blocked(`${what}: остановлено человеком после ${round} раундов`);
  if (k === 'spec') throw new Blocked(`${what}: нужна правка замороженной спеки — исправь артефакты и согласуй заново (новый run)`);
  if (k === 'hint') return { kind: 'more', hint: await ctx.human.text('Указание для implementer', 'Сначала исправь блокирующие находки ревьюера, ничего вне батча не трогай'), note };
  return { kind: k, note };
}

/** Петля task batch: реализация → гейты → коммит → ревью кода; после лимита решаешь ты. */
async function batchLoop(ctx: Ctx, b: BatchState): Promise<void> {
  const all = st(ctx).apply.batches;
  const next = all.slice(all.indexOf(b) + 1).find((x) => x.status !== 'done');
  const scope: PassScope = { loop: `batch:${b.id}`, label: `считать батч ${b.id} выполненным → ${next ? `батч ${next.id}` : 'acceptance'}` };
  await passLoop(ctx, scope, () => batchRounds(ctx, b), async (reason) => {
    // implementer мог быть прерван посреди записи: его правки — в пределах ACL и в коммите батча.
    await checkBoundary(ctx, 'implementer');
    b.head = await commitAll(ctx.wt, `agentflow(${st(ctx).change}): batch ${b.id} пройден решением человека`);
    Object.assign(b, { status: 'done', passedBy: 'human' });
    closeLoop(ctx, scope, reason, b.head!);
  });
}

async function batchRounds(ctx: Ctx, b: BatchState): Promise<void> {
  const loop = `batch:${b.id}`;
  const max = ctx.policy.limits.batchRounds;
  const batch: TaskBatch = { id: b.id, title: b.title, tasks: b.tasks };
  b.base ??= await head(ctx.wt);
  let session: string | undefined;
  let toFix: Finding[] = [];
  const failures: string[] = [];
  const history: string[][] = [];
  let prevHead = b.base;
  let budget = max;
  let fresh = false;
  let lastDiff: string | undefined;
  /** Батч принят: после PASS code-reviewer или по зелёным гейтам без него. */
  const done = async (verdict: string, note: string, round: number): Promise<void> => {
    b.status = 'done';
    for (const t of b.tasks) t.done = true;
    tickTasks(b.tasks);
    b.head = await commitAll(ctx.wt, `agentflow(${st(ctx).change}): batch ${b.id} выполнен`);
    ctx.store.save();
    log.verdict(verdict, note, 'батч принят');
    log.loopClose(`batch ${b.id} принят на раунде ${round}`);
  };
  for (let round = 1; ; round++) {
    b.rounds++;
    ctx.store.save();
    log.loopOpen(`task batch ${b.id} «${b.title}»`, round, Math.max(budget, round));
    verifyFreeze(ctx);
    // После второго неудачного раунда условия меняются: новый implementer со свежим контекстом и сводкой провалов.
    if (round === 3 || fresh) {
      log.step('условия меняются: новый implementer со свежим контекстом и сводкой провалов');
      session = undefined;
      fresh = false;
    }
    log.step(`пакет контекста: ${batch.tasks.length} задач, требования и сценарии, разрешённые пути, Definition of Done`);
    const label = `batch-${b.id}-r${b.rounds}`;
    const impl = await implementWithGates(ctx, { batch, round, max: Math.max(budget, round), toFix, failures, session, label, loop });
    session = impl.session;
    let gateFailed = false;
    if (!impl.green) {
      gateFailed = true;
      const f = synthetic(ctx, loop, round, 'gate', {
        severity: 'critical',
        problem: `гейты красные после ${ctx.policy.limits.gateAttempts} попыток`,
        location: impl.gates.find((g) => !g.ok)?.logPath ?? 'gates',
        evidence: gatesSummary(impl.gates, 20),
      });
      failures.push(`раунд ${round}: гейты красные после всех попыток`);
      ctx.store.loop(loop, round, 'REVISE', 'гейты красные');
      log.verdict('REVISE', 'гейты красные после всех попыток', round < budget ? `раунд ${round + 1}` : 'автоматические раунды кончились');
      log.loopClose('REVISE (гейты)');
      toFix = [f];
      history.push(['gates']);
    } else {
      const headSha = await commitAll(ctx.wt, `agentflow(${st(ctx).change}): batch ${b.id} раунд ${round}`);
      const diffText = await diff(ctx.wt, b.base, headSha);
      const diffPath = join(ctx.contextsDir, `${label}.diff`);
      writeFileSync(diffPath, diffText || '(пустой diff)\n');
      lastDiff = diffPath;
      let fixDiffPath: string | undefined;
      if (round > 1 && prevHead !== headSha) {
        fixDiffPath = join(ctx.contextsDir, `${label}-fix.diff`);
        writeFileSync(fixDiffPath, await diff(ctx.wt, prevHead, headSha));
      }
      const snap = codeSnapshot(b.base, headSha, diffText);
      log.step(`коммит ${headSha.slice(0, 10)} · snapshot кода ${short(snap)} (base ${b.base.slice(0, 8)} → head ${headSha.slice(0, 8)})`);
      if (!on(ctx, 'code-reviewer')) {
        ctx.store.loop(loop, round, 'SKIPPED', 'code-reviewer выключен');
        return done('SKIPPED', 'гейты зелёные, code-reviewer выключен в настройках run', round);
      }

      ctx.store.setStep(`apply:${b.id}:review`);
      const rubric = loadRubric(ctx.root, 'batch');
      let review = await callReviewer(
        ctx,
        'code-reviewer',
        codeReviewPrompt(base(ctx), {
          batch,
          round,
          max: Math.max(budget, round),
          reqs: requirements(ctx),
          specFiles: specFiles(ctx),
          diffPath,
          fixDiffPath,
          base: b.base,
          head: headSha,
          gates: gatesSummary(impl.gates),
          rubric,
          snapshotId: snap,
          prior: openFindings(ctx, loop),
        }),
        { kind: 'code-review', batchId: b.id, snapshotId: snap, round, checks: rubric.mandatory, target: `batch-${b.id}` },
        { role: 'code-reviewer', target: `batch-${b.id}`, snapshotId: snap, round, mandatoryChecks: rubric.mandatory, needAssessments: true },
        `${label}-review`,
      );
      if ((await head(ctx.wt)) !== headSha || treeChanges(await changedPaths(ctx.wt)).length) throw new Blocked(`batch ${b.id}: код изменился во время ревью — вердикт недействителен`);
      if (ctx.inject.repeat(`batch-stuck:${b.id}`, max)) review = injectRevise(review, `${diffPath}:1`, round, 'INJ-STUCK');
      else if (ctx.inject.take(`batch-revise:${b.id}`)) review = injectRevise(review, `${diffPath}:1`, round);
      review = injectBlocked(ctx, loop, review);

      const d = decide(review, 'apply');
      await applyReview(ctx, loop, round, review, d);
      ctx.store.loop(loop, round, d.verdict, d.reason);
      const counts = countBySeverity(review.findings);
      if (d.verdict === 'BLOCKED') {
        log.verdict('BLOCKED', d.reason, 'решаешь ты');
        log.loopClose('BLOCKED');
        const r = await onBlocker(ctx, {
          gate: `blocked:batch ${b.id}`,
          title: `batch ${b.id}: code-reviewer не может принять батч`,
          reason: `batch ${b.id}: ${d.reason}`,
          roles: ['code-reviewer', 'implementer'],
          files: [diffPath],
        });
        // Следующий раунд: implementer с контекстом человека, затем гейты и ревью.
        toFix = [
          synthetic(ctx, loop, round, 'human', { problem: `Контекст от человека: ${r.text}`, location: 'batch', evidence: 'решение человека' }),
          ...(r.note ? [synthetic(ctx, loop, round, 'human', { problem: r.note, location: 'batch', evidence: 'обсуждение решения' })] : []),
        ];
        prevHead = headSha;
        budget = Math.max(budget, round + 1);
        continue;
      }
      if (d.verdict === 'PASS') return done('PASS', counts, round);
      failures.push(`раунд ${round}: ${d.blocking.map((f) => `${f.id} ${f.problem}`).join('; ')}`);
      log.verdict('REVISE', counts, round < budget ? `раунд ${round + 1}: ${round + 1 === 3 ? 'новый implementer' : 'та же сессия implementer'}` : 'автоматические раунды кончились');
      log.loopClose('REVISE');
      toFix = stored(ctx, loop, d.blocking);
      history.push(toFix.map((f) => f.id));
      prevHead = headSha;
    }
    if (round < budget) continue;
    const ex = await applyExhausted(ctx, `batch ${b.id}`, round, toFix, history, gateFailed, lastDiff ? [lastDiff] : []);
    budget = round + 1;
    if (ex.kind === 'fresh') fresh = true;
    if (ex.hint) toFix = [...toFix, synthetic(ctx, loop, round, 'human', { problem: `Указание человека: ${ex.hint}`, location: 'batch', evidence: 'решение человека' })];
    if (ex.note) toFix = [...toFix, synthetic(ctx, loop, round, 'human', { problem: ex.note, location: 'batch', evidence: 'обсуждение решения' })];
  }
}

async function stageApply(ctx: Ctx): Promise<void> {
  log.phase('ФАЗА APPLY · task batches из файла задач схемы');
  verifyFreeze(ctx);
  const s = st(ctx);
  if (!s.apply.batches.length) {
    // Задачи разбирает сам OpenSpec по apply.tracks схемы; уже отмеченные считаются выполненными.
    const batches = batchesFromTasks(await ctx.os.applyTasks(s.change));
    if (!batches.length) throw new Blocked('openspec instructions apply: в change нет задач');
    s.apply.batches = batches.map((b) => {
      const tasks = b.tasks.map((t) => ({ id: t.id, text: t.text, done: !!t.done, file: t.file, line: t.line }));
      return { id: b.id, title: b.title, tasks, status: tasks.every((t) => t.done) ? 'done' : 'pending', rounds: 0 };
    });
    ctx.store.save();
  }
  log.info(`батчей: ${s.apply.batches.length} — ${s.apply.batches.map((b) => `${b.id}. ${b.title}${b.status === 'done' ? ' (уже выполнен)' : ''}`).join('; ')}`);
  for (const b of s.apply.batches) if (b.status !== 'done') await batchLoop(ctx, b);
  const byHuman = s.apply.batches.filter((b) => b.passedBy === 'human').map((b) => b.id);
  log.info(byHuman.length ? c.yellow(`все батчи закрыты, решением человека: ${byHuman.join(', ')} → acceptance`) : c.green('все батчи PASS → acceptance'));
}

// ───────────────────────────── acceptance и финал ─────────────────────────────

/** Артефакт схемы с планом приёмки (test-plan и подобные), если он есть. */
function testPlanNode(ctx: Ctx): ArtifactNode | undefined {
  return ctx.graph.find((n) => /test|acceptance|qa/i.test(n.id) || /test|acceptance/i.test(n.outputPath));
}

async function runAcceptance(ctx: Ctx, extra: Finding[], label: string): Promise<Decision> {
  verifyFreeze(ctx);
  const snap = st(ctx).spec.freeze!.digest;
  const reqs = requirements(ctx);
  const scenarioIds = reqs.flatMap((r) => r.scenarios.map((x) => x.id));
  const rubric = loadRubric(ctx.root, 'acceptance');
  const tp = testPlanNode(ctx);
  const testPlan = tp ? filesOf(ctx, tp).join(', ') : undefined;
  const acc = ctx.policy.acceptance;
  let prompt = acceptancePrompt(base(ctx), { reqs, specFiles: specFiles(ctx), testPlan, snapshotId: snap, rubric, dir: acc.dir, framework: acc.framework, shell: ctx.policy.roles['acceptance-tester']?.shell ?? [] });
  if (extra.length) prompt += `\n\n## Находки к твоим тестам (финальное ревью или решение человека)\n${extra.map((f) => `- ${f.id} ${f.location}: ${f.problem}`).join('\n')}\nИсправь тесты, не ослабляя ожидаемое поведение.`;
  let review = await callReviewer(
    ctx,
    'acceptance-tester',
    prompt,
    { kind: 'acceptance', snapshotId: snap, round: 1, checks: scenarioIds, target: 'acceptance', requirements: reqs },
    { role: 'acceptance-tester', target: 'acceptance', snapshotId: snap, round: 1, mandatoryChecks: scenarioIds },
    label,
  );
  await checkBoundary(ctx, 'acceptance-tester');
  const commit = await commitAll(ctx.wt, `agentflow(${st(ctx).change}): acceptance-тесты`);
  const evidence = join(ctx.wt, ctx.policy.acceptance.dir, 'evidence');
  if (existsSync(evidence)) cpSync(evidence, join(ctx.runDir, 'evidence'), { recursive: true });
  review = injectBlocked(ctx, 'acceptance', review);
  const d = decide(review, 'apply');
  await applyReview(ctx, 'acceptance', 1, review, d);
  ctx.store.loop('acceptance', 1, d.verdict, d.reason);
  writeFileSync(join(ctx.contextsDir, 'acceptance-report.json'), JSON.stringify(review, null, 2));
  st(ctx).acceptance = { status: d.verdict, snapshot: snap, report: review };
  ctx.store.save();
  const passed = review.checks.filter((x) => x.result === 'PASS').length;
  log.verdict(d.verdict, `сценариев PASS ${passed}/${review.checks.length} · коммит ${commit.slice(0, 10)}`, d.verdict === 'BLOCKED' ? 'решаешь ты' : 'полные гейты и финальное ревью');
  if (d.verdict !== 'BLOCKED') return d;
  const r = await onBlocker(ctx, {
    gate: `blocked:${label}`,
    title: 'Acceptance: acceptance-tester не может проверить change',
    reason: `acceptance: ${d.reason}`,
    roles: ['acceptance-tester'],
    files: [join(ctx.contextsDir, 'acceptance-report.json'), ctx.policy.acceptance.dir],
  });
  // acceptance-tester снова, с контекстом человека как находкой к тестам.
  const human = [synthetic(ctx, 'acceptance', 1, 'human', { problem: `Контекст от человека: ${r.text}${r.note ? `\n${r.note}` : ''}`, location: ctx.policy.acceptance.dir, evidence: 'решение человека' })];
  return runAcceptance(ctx, [...extra, ...human], `${label}-ctx`);
}

async function stageAcceptance(ctx: Ctx): Promise<void> {
  log.phase('ACCEPTANCE · acceptance-tester по замороженной спеке');
  if (!on(ctx, 'acceptance-tester')) {
    const s = st(ctx);
    s.acceptance = { status: 'SKIPPED', snapshot: s.spec.freeze!.digest, report: null };
    ctx.store.loop('acceptance', 1, 'SKIPPED', 'acceptance-tester выключен');
    log.step('acceptance пропущен: acceptance-tester выключен в настройках run');
    return;
  }
  const scope: PassScope = { loop: 'acceptance', label: 'считать acceptance пройденным → финальное ревью' };
  await passLoop(
    ctx,
    scope,
    async () => void (await runAcceptance(ctx, [], 'acceptance')),
    async (reason) => {
      const s = st(ctx);
      await checkBoundary(ctx, 'acceptance-tester');
      await commitAll(ctx.wt, `agentflow(${s.change}): acceptance пройден решением человека`);
      s.acceptance = { status: 'PASSED_BY_HUMAN', snapshot: s.spec.freeze!.digest, report: s.acceptance?.report ?? null };
      closeLoop(ctx, scope, reason, s.spec.freeze!.digest);
    },
  );
}

/** Финальное ревью: полные гейты → ревью с трассировкой; ≤ finalFixRounds раундов исправлений. */
async function stageFinal(ctx: Ctx): Promise<void> {
  log.phase('ФИНАЛ · полные гейты и финальное ревью трассировки');
  const scope: PassScope = { loop: 'final', label: 'Принять без финального ревью → отчёт приёмки' };
  await passLoop(ctx, scope, () => finalRounds(ctx), async (reason) => {
    const s = st(ctx);
    await checkBoundary(ctx, ['implementer', 'acceptance-tester']);
    const sha = await commitAll(ctx.wt, `agentflow(${s.change}): финальное ревью пройдено решением человека`);
    s.final = { status: 'PASSED_BY_HUMAN', snapshot: sha, rounds: s.loops.filter((l) => l.loop === 'final').length, traceability: [] };
    closeLoop(ctx, scope, reason, sha);
  });
}

async function finalRounds(ctx: Ctx): Promise<void> {
  const s = st(ctx);
  const maxFix = ctx.policy.limits.finalFixRounds;
  const loop = 'final';
  let budget = maxFix + 1;
  const history: string[][] = [];
  let hint: string | undefined;
  for (let round = 1; ; round++) {
    log.loopOpen('финальное ревью', round, Math.max(budget, round));
    verifyFreeze(ctx);
    ctx.store.setStep('final:gates');
    log.step(`полные гейты: ${ctx.policy.gates.full.join(', ')}`);
    const gates = await runGates(ctx.policy.gates.full, { cwd: ctx.wt, logDir: ctx.gatesDir, step: `final-r${round}`, policy: ctx.policy });
    recordGates(ctx, gates);
    const headSha = await commitAll(ctx.wt, `agentflow(${s.change}): финальные гейты`);
    const diffText = await diff(ctx.wt, s.apply.base!, headSha);
    const diffPath = join(ctx.contextsDir, `final-r${round}.diff`);
    writeFileSync(diffPath, diffText);
    const snap = codeSnapshot(s.apply.base!, headSha, diffText);
    log.step(`snapshot ${short(snap)} · head ${headSha.slice(0, 10)}`);
    const reqs = requirements(ctx);
    const rubric = loadRubric(ctx.root, 'final');
    // Без code-reviewer вердикт дают полные гейты: красные — находка critical, дальше тот же раунд implementer.
    const reviewed = on(ctx, 'code-reviewer');
    ctx.store.setStep(reviewed ? 'final:review' : 'final:gates-only');
    let review = !reviewed
      ? gatesOnlyReview(gates, snap, round)
      : await callReviewer(
      ctx,
      'code-reviewer',
      finalReviewPrompt(base(ctx), {
        round,
        max: Math.max(budget, round),
        reqs,
        specFiles: specFiles(ctx),
        diffPath,
        base: s.apply.base!,
        head: headSha,
        gates: gatesSummary(gates),
        acceptancePath: join(ctx.contextsDir, 'acceptance-report.json'),
        acceptanceDir: ctx.policy.acceptance.dir,
        acceptanceOff: !on(ctx, 'acceptance-tester'),
        rubric,
        snapshotId: snap,
        prior: openFindings(ctx, loop),
      }),
      { kind: 'final-review', snapshotId: snap, round, checks: rubric.mandatory, target: 'final', requirements: reqs },
      { role: 'code-reviewer', target: 'final', snapshotId: snap, round, mandatoryChecks: rubric.mandatory, needAssessments: true, requireTrace: reqs.map((r) => r.id) },
      `final-r${round}-review`,
    );
    if (reviewed && ctx.inject.take('final-revise')) review = injectRevise(review, `${diffPath}:1`, round);
    if (reviewed) review = injectBlocked(ctx, loop, review);
    const d = decide(review, 'apply');
    await applyReview(ctx, loop, round, review, d);
    ctx.store.loop(loop, round, reviewed ? d.verdict : d.verdict === 'PASS' ? 'SKIPPED' : 'RED', reviewed ? d.reason : 'code-reviewer выключен: только полные гейты');
    let blocking: Finding[];
    if (d.verdict === 'BLOCKED') {
      log.verdict('BLOCKED', d.reason, 'решаешь ты');
      const r = await onBlocker(ctx, {
        gate: 'blocked:final',
        title: 'Финальное ревью: code-reviewer не может принять change',
        reason: `финальное ревью: ${d.reason}`,
        roles: ['code-reviewer', 'implementer'],
        files: [diffPath],
      });
      // Раунд исправлений по находке человека, затем полные гейты и ревью.
      blocking = [
        synthetic(ctx, loop, round, 'human', { problem: `Контекст от человека: ${r.text}`, location: 'final', evidence: 'решение человека' }),
        ...(r.note ? [synthetic(ctx, loop, round, 'human', { problem: r.note, location: 'final', evidence: 'обсуждение решения' })] : []),
      ];
      budget = Math.max(budget, round + 1);
    } else if (d.verdict === 'PASS') {
      s.final = { status: reviewed ? 'PASS' : 'GATES_ONLY', snapshot: snap, rounds: round, traceability: review.traceability ?? [] };
      ctx.store.save();
      log.verdict(reviewed ? 'PASS' : 'SKIPPED', reviewed ? countBySeverity(review.findings) : 'полные гейты зелёные, code-reviewer выключен в настройках run', 'отчёт приёмки');
      log.loopClose('финальное ревью пройдено');
      return;
    } else {
      blocking = stored(ctx, loop, d.blocking);
      history.push(blocking.map((f) => f.id));
    }
    if (d.verdict !== 'BLOCKED' && round >= budget) {
      log.verdict('REVISE', countBySeverity(review.findings), 'автоматические раунды исправлений кончились');
      const ex = await applyExhausted(ctx, 'финальное ревью', round, blocking, history, !gates.every((g) => g.ok), [diffPath]);
      budget = round + 1;
      hint = ex.hint;
      if (ex.note) blocking.push(synthetic(ctx, loop, round, 'human', { problem: ex.note, location: 'final', evidence: 'обсуждение решения' }));
    }
    if (hint) blocking.push(synthetic(ctx, loop, round, 'human', { problem: `Указание человека: ${hint}`, location: 'final', evidence: 'решение человека' }));
    hint = undefined;
    const accDir = ctx.policy.acceptance.dir.replace(/\/$/, '') + '/';
    // Без acceptance-tester находки по тестам тоже исправляет implementer.
    const e2e = on(ctx, 'acceptance-tester') ? blocking.filter((f) => f.location.startsWith(accDir)) : [];
    const code = blocking.filter((f) => !e2e.includes(f));
    log.verdict('REVISE', countBySeverity(review.findings), `раунд исправлений ${round}/${Math.max(budget - 1, round)}: ${code.length ? 'implementer' : ''}${code.length && e2e.length ? ' + ' : ''}${e2e.length ? 'acceptance-tester' : ''}`);
    if (code.length) {
      const batch: TaskBatch = { id: `final-${round}`, title: 'исправления по финальному ревью', tasks: code.map((f, i) => ({ id: `F.${i + 1}`, text: `${f.id}: ${f.requiredChange ?? f.problem}` })) };
      const impl = await implementWithGates(ctx, { batch, round, max: Math.max(budget - 1, round), toFix: code, failures: [], label: `final-fix-${round}`, loop });
      if (!impl.green) log.warn('гейты после исправлений красные — финальное ревью увидит это как critical');
      await commitAll(ctx.wt, `agentflow(${s.change}): исправления финального ревью, раунд ${round}`);
    }
    if (e2e.length) await runAcceptance(ctx, e2e, `acceptance-fix-${round}`);
    log.loopClose('исправлено → полные гейты и ревью на новом snapshot');
  }
}

function manualCheck(ctx: Ctx): string {
  if (specRun(ctx)) return '';
  const tp = ctx.graph.length ? testPlanNode(ctx) : undefined;
  for (const f of tp ? filesOf(ctx, tp) : []) {
    const m = readFileSync(join(ctx.wt, f), 'utf8').split(/^## /m).find((x) => /^(Manual check|Ручная проверка)/i.test(x));
    if (m) return `В каталоге \`${ctx.wt}\`:\n\n${m.replace(/^(Manual check|Ручная проверка)\s*/i, '').trim()}`;
  }
  return '';
}

async function stageReport(ctx: Ctx): Promise<void> {
  log.phase('ОТЧЁТ ПРИЁМКИ');
  const path = writeAcceptanceReport(ctx.runDir, st(ctx), manualCheck(ctx));
  log.step(`ACCEPTANCE.md: ${path}`);
  writeManifest(ctx);
}

/** Человеческий шлюз 2: ручная приёмка. */
async function stageHumanAcceptance(ctx: Ctx): Promise<void> {
  log.phase('ПРИЁМКА · человеческий шлюз 2 из 2');
  const s = st(ctx);
  if (ctx.human.auto && s.options.untilReview) throw new Parked('парковка на приёмке');
  if (specRun(ctx)) return acceptSpec(ctx);
  const acc = s.acceptance?.report as { checks?: { result: string }[] } | undefined;
  const passed = acc?.checks?.filter((x) => x.result === 'PASS').length ?? 0;
  const total = acc?.checks?.length ?? 0;
  const mc = manualCheck(ctx);
  const byHuman = (loop: string) => s.proceeded.find((p) => p.loop === loop);
  const fin = byHuman('final');
  const finalLine = fin
    ? `финальное ревью пройдено решением человека: ${fin.reason}`
    : s.final?.status === 'GATES_ONLY'
      ? 'финальное ревью: только полные гейты (code-reviewer выключен)'
      : `финальное ревью ${s.final?.status ?? '—'}`;
  const accBy = byHuman('acceptance');
  const accLine = accBy
    ? `acceptance пройден решением человека: ${accBy.reason}`
    : s.acceptance?.status === 'SKIPPED'
      ? 'acceptance не запускался (acceptance-tester выключен)'
      : `${passed}/${total} acceptance-сценариев прошли`;
  const k = await ctx.human.select({
    title: 'Принять change?',
    context: [
      `отчёт: ${join(ctx.runDir, 'ACCEPTANCE.md')}`,
      `код для ручного теста: ${ctx.wt} (ветка ${s.branch})`,
      `${finalLine} · ${accBy || s.acceptance?.status === 'SKIPPED' ? accLine : `acceptance ${passed}/${total} сценариев PASS`}`,
      ...(s.proceeded.length ? [`пройдено решением человека: ${s.proceeded.map((p) => p.loop).join(', ')} — см. ACCEPTANCE.md`] : []),
      ...(mc ? [mc.replace(/\n+/g, ' · ')] : []),
    ],
    options: [
      { key: 'accept', label: 'Принять → openspec archive', description: 'дельты спеки переносятся в openspec/specs, merge — вне конвейера' },
      { key: 'reject', label: 'Отклонить', description: 'run завершается со статусом rejected, причина — в отчёт' },
    ],
    recommended: 'accept',
    rationale: `${fin || s.final?.status === 'GATES_ONLY' ? finalLine : 'финальное ревью PASS'}, ${accLine} — осталась твоя ручная проверка`,
  });
  const comment = k === 'reject' ? await ctx.human.text('Причина отказа', 'не прошла ручная проверка') : undefined;
  s.decisions.push({ at: now(), gate: 'acceptance', decision: k === 'accept' ? 'accepted' : 'rejected', comment });
  ctx.store.save();
  if (k === 'reject') {
    s.status = 'rejected';
    s.stopReason = `отклонено при приёмке${comment ? `: ${comment}` : ''}`;
    ctx.store.save();
    throw new Blocked(s.stopReason);
  }
}

/**
 * Приёмка run только со спекой. Спеку человек уже принял на freeze; заново спрашивать нужно, только
 * если freeze выбрал автопилот режима --auto-until-review, а решения перешли к человеку.
 */
async function acceptSpec(ctx: Ctx): Promise<void> {
  const s = st(ctx);
  if (!s.options.untilReview) {
    log.step('implementer выключен: спека принята на freeze, кода и приёмки кода нет');
    return;
  }
  const k = await ctx.human.select({
    title: 'Принять спеку?',
    context: [
      `отчёт: ${join(ctx.runDir, 'ACCEPTANCE.md')}`,
      `спека: ${changeDirAbs(ctx)} (ветка ${s.branch}) · digest ${short(s.spec.freeze?.digest ?? '')}`,
      'implementer выключен: кода нет, change остаётся активным, archive не выполняется',
    ],
    options: [
      { key: 'accept', label: 'Принять спеку', description: `run завершается; код — после merge ветки: agentflow run --change ${s.change}` },
      { key: 'reject', label: 'Отклонить', description: 'run завершается со статусом rejected, причина — в отчёт' },
    ],
    recommended: 'accept',
    rationale: 'freeze выбрал автопилот, спека прошла валидацию и ревью — осталось твоё чтение спеки',
  });
  const comment = k === 'reject' ? await ctx.human.text('Причина отказа', 'спека не годится') : undefined;
  s.decisions.push({ at: now(), gate: 'acceptance', decision: k === 'accept' ? 'accepted' : 'rejected', comment });
  ctx.store.save();
  if (k === 'reject') {
    s.status = 'rejected';
    s.stopReason = `спека отклонена при приёмке${comment ? `: ${comment}` : ''}`;
    ctx.store.save();
    throw new Blocked(s.stopReason);
  }
}

async function stageArchive(ctx: Ctx): Promise<void> {
  if (specRun(ctx)) {
    // Дельты спеки уходят в openspec/specs только вместе с кодом: change остаётся активным для run с implementer.
    const s = st(ctx);
    s.status = 'accepted';
    ctx.store.save();
    writeAcceptanceReport(ctx.runDir, s, '');
    log.info(c.green(`спека принята без archive · коммит freeze ${s.spec.freeze?.commit.slice(0, 10) ?? '—'} в ветке ${s.branch}`));
    log.info(`код: ${mergeSteps(s).join(' && ')}, затем agentflow run --change ${s.change}`);
    return;
  }
  log.phase('ARCHIVE');
  tickTasks(st(ctx).apply.batches.flatMap((b) => b.tasks));
  const out = await ctx.os.archive(st(ctx).change);
  log.step(out.trim().split('\n').slice(-3).join(' · '));
  const commit = await commitAll(ctx.wt, `agentflow(${st(ctx).change}): archive`);
  st(ctx).status = 'accepted';
  ctx.store.save();
  writeAcceptanceReport(ctx.runDir, st(ctx), manualCheck(ctx));
  log.info(c.green(`change принят и заархивирован · коммит ${commit.slice(0, 10)} в ветке ${st(ctx).branch}`));
  log.info(`merge вне конвейера: ${mergeSteps(st(ctx)).join(' && ')}`);
}

const STAGE_FN: Record<Stage, (ctx: Ctx) => Promise<void>> = {
  clarify: stageClarify,
  spec: stageSpec,
  approval: stageApproval,
  freeze: stageFreeze,
  apply: stageApply,
  acceptance: stageAcceptance,
  final: stageFinal,
  report: stageReport,
  'human-acceptance': stageHumanAcceptance,
  archive: stageArchive,
};

// ───────────────────────────── запуск, resume, manifest ─────────────────────────────

/** Ревизия промптов: роли и рубрики kit плюс переопределения целевого репозитория. */
function promptsRevision(repo: string): string {
  const rubricDirs = [join(KIT, '.agentflow/rubrics'), join(repo, '.agentflow/rubrics')].filter((d, i, a) => existsSync(d) && a.indexOf(d) === i);
  const files = [...roleFiles(repo).map((r) => r.path), ...rubricDirs.flatMap((d) => readdirSync(d).map((f) => join(d, f)))].sort();
  return sha256(files.map((f) => readFileSync(f, 'utf8')).join('\n'));
}

function sdkVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(KIT, 'node_modules/@qwen-code/sdk/package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function writeManifest(ctx: Ctx): void {
  const s = st(ctx);
  const manifest = {
    run: { id: s.runId, change: s.change, createdAt: s.createdAt, mock: s.options.mock, inject: s.options.inject },
    qwen: { executable: qwenExecutable(ctx.policy) ?? 'bundled', sdkVersion: s.versions.sdk, effortViaSdk: ctx.policy.qwen.effortViaSdk },
    openspec: { version: s.versions.openspec, schema: s.spec.schema ?? ctx.policy.openspec.schema, bin: ctx.os.bin },
    kit: KIT,
    policy_sources: ctx.policy.sources,
    git: { branch: s.branch, worktree: s.worktree, base: s.baseCommit },
    models: Object.fromEntries(
      ROLES.map((n) => {
        const r = ctx.roles.get(n)!;
        return [n, { id: r.model, effort: r.effort ?? null, resolved: s.models[n]?.actual ?? [] }];
      }),
    ),
    prompts: { revision: s.versions.prompts },
    policy: { revision: s.versions.policy },
  };
  writeFileSync(join(ctx.runDir, 'manifest.yaml'), stringify(manifest));
}

function makeCtx(root: string, runDir: string, store: RunStore, policy: Policy, roles: Map<string, RoleDef>): Ctx {
  const s = store.state;
  const contextsDir = join(runDir, 'contexts');
  const reviewsDir = join(runDir, 'reviews');
  const gatesDir = join(runDir, 'gates');
  for (const d of [contextsDir, reviewsDir, gatesDir, join(runDir, 'evidence')]) mkdirSync(d, { recursive: true });
  const schemaPath = join(contextsDir, 'review.schema.json');
  copyFileSync(join(KIT, '.agentflow/review.schema.json'), schemaPath);
  setLogSink((e) => store.append(e));
  configureThinking({ dir: join(runDir, 'thinking') });
  const rt: RoleRuntime = {
    policy,
    change: s.change,
    worktree: s.worktree,
    contextsDir,
    ledger: (e) => store.append(e),
    ...(s.options.mock ? { mock: runMock } : {}),
  };
  return {
    root,
    wt: s.worktree,
    runDir,
    contextsDir,
    schemaPath,
    reviewsDir,
    gatesDir,
    store,
    policy,
    roles,
    os: new OpenSpec(root, s.worktree, s.versions.openspecBin),
    rt,
    human: new Human(autopilotOn(s.options, s.handover), undefined, !!s.options.untilReview),
    inject: new Injector(store),
    scopes: new Scopes(),
    graph: [],
    tracked: new Set(),
  };
}

async function pipeline(ctx: Ctx): Promise<void> {
  const s = st(ctx);
  const status = await ctx.os.status(s.change);
  ctx.graph = topoOrder(status.artifacts);
  ctx.tracked = new Set(status.applyRequires);
  s.spec.order = ctx.graph.map((n) => n.id);
  s.spec.schema = status.schemaName;
  const out = process.stdout;
  const stall = ctx.policy.limits.stallMinutes;
  const apiSeconds = ctx.policy.qwen.apiTimeoutSeconds || 120;
  if (stall > 0 && stall * 60 <= apiSeconds) {
    log.warn(
      `limits.stallMinutes (${stall} мин) не больше таймаута запроса к модели (${apiSeconds} с, qwen.apiTimeoutSeconds): ` +
        'сторож простоя может сработать раньше, чем CLI дождётся ответа модели',
    );
  }
  panel.start({
    runId: s.runId,
    change: s.change,
    roles: ROLES.length - s.options.skip.length,
    launches: Object.values(s.usage).reduce((n, u) => n + u.calls, 0),
    phase: `этап ${s.stage}`,
    stallMs: stallMs(ctx.rt),
    enabled: panelEnabled({ isTTY: out.isTTY, rows: out.rows, cols: out.columns, noPanel: NO_PANEL, env: process.env }),
  });
  const clicks = mouseEnabled({ stdinTTY: process.stdin.isTTY, stdoutTTY: out.isTTY, noMouse: NO_MOUSE, env: process.env });
  screen.start({ enabled: clicks, out, err: process.stderr, logBottom: () => panel.logBottom() });
  mouse.start({ enabled: clicks, input: process.stdin, out, handlers: { click: (_x, y) => screen.click(y), cursor: (row) => screen.cursor(row) } });
  if (s.options.skip.length) log.warn(`выключены роли: ${s.options.skip.join(', ')} · пропускаются: ${skippedSteps(s.options.skip).join('; ')}`);
  if (s.options.untilReview) {
    log.info(
      s.handover
        ? c.yellow(`режим --auto-until-review: решения принимает человек с ${s.handover.at} (${s.handover.reason})`)
        : c.yellow(`режим --auto-until-review: решения до приёмки — автопилот без waiver и перехода дальше, run паркуется на «${specRun(ctx) ? 'Принять спеку?' : 'Принять change?'}»`),
    );
  }
  log.info(`схема OpenSpec: ${status.schemaName} · артефакты: ${ctx.graph.map((n) => n.id).join(' → ')} · apply требует: ${status.applyRequires.join(', ') || '—'}`);
  ctx.store.save();
  try {
    for (const stage of STAGES) {
      if (s.stagesDone.includes(stage)) continue;
      s.stage = stage;
      ctx.store.save();
      if (specRun(ctx) && CODE_STAGES.includes(stage)) log.step(`этап ${stage} пропущен: implementer выключен`);
      else await STAGE_FN[stage](ctx);
      s.stagesDone.push(stage);
      ctx.store.save();
      if (ctx.inject.take(`kill-after:${stage}`)) {
        log.error(`контроллер убит после этапа ${stage}; продолжи: agentflow resume ${s.runId}`);
        process.exit(137);
      }
    }
    printLoopSummary(s);
    console.log('\n' + c.green(c.bold(specRun(ctx) ? `✔ run ${s.runId}: спека change ${s.change} принята` : `✔ run ${s.runId}: change ${s.change} принят`)));
  } catch (e) {
    if (e instanceof Parked) {
      s.status = 'awaiting-review';
      s.handover = { at: now(), reason: e.message };
      ctx.store.save();
      const report = writeAcceptanceReport(ctx.runDir, s, manualCheck(ctx));
      writeManifest(ctx);
      printLoopSummary(s);
      console.log('\n' + c.yellow(c.bold(`⏸ run ${s.runId}: ${specRun(ctx) ? 'спека' : 'change'} ${s.change} ждёт твоего ревью`)));
      console.log(`отчёт: ${report}`);
      console.log(specRun(ctx) ? `спека: ${changeDirAbs(ctx)} (ветка ${s.branch})` : `код для ручного теста: ${s.worktree} (ветка ${s.branch})`);
      console.log(`принять или отклонить: agentflow resume ${s.runId}`);
      return;
    }
    if (!(e instanceof Blocked)) {
      s.status = 'failed';
      s.stopReason = e instanceof Error ? e.stack ?? e.message : String(e);
      ctx.store.save();
      throw e;
    }
    if (s.status === 'running') s.status = 'blocked';
    s.stopReason = e.message;
    // Остановка режима — решения этого run дальше принимает человек, и после resume тоже.
    if (s.options.untilReview && !s.handover) s.handover = { at: now(), reason: `BLOCKED: ${oneLine(e.message, 200)}` };
    ctx.store.save();
    log.error(`${s.status.toUpperCase()}: ${e.message}`);
    writeAcceptanceReport(ctx.runDir, s, manualCheck(ctx));
    writeManifest(ctx);
    printLoopSummary(s);
    console.log(`\nпричина записана в ${ctx.store.statePath}; продолжить после исправления: agentflow resume ${s.runId}`);
    process.exitCode = 2;
  } finally {
    mouse.stop();
    screen.stop();
    panel.stop();
  }
}

function readIntent(arg: string): { text: string; change?: string; source: string } {
  const path = resolve(process.env['INIT_CWD'] ?? process.cwd(), arg);
  if (!existsSync(path)) return { text: arg, source: 'argv' };
  const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const change = m?.[1]?.match(/^change:\s*([\w-]+)\s*$/m)?.[1];
  const fallback = basename(path, '.md').replace(/^\d+[-_]/, '');
  return { text: (m ? m[2]! : raw).trim(), change: change ?? fallback, source: arg };
}

/** Intent существующего change: его первый артефакт (обычно proposal) или README. */
function intentFromChange(dir: string, change: string): string {
  for (const f of ['proposal.md', 'README.md']) {
    const p = join(dir, f);
    if (existsSync(p)) return `Существующий change «${change}»: доведи его до приёмки по схеме репозитория.\n\n${readFileSync(p, 'utf8').trim()}`;
  }
  return `Существующий change «${change}»: доведи его до приёмки по схеме репозитория.`;
}

async function startRun(args: { intent?: string; change?: string; autoApprove: boolean; untilReview: boolean; mock: boolean; clarify: boolean; worktree: boolean; inject: string[]; skipRoles?: string }): Promise<void> {
  const flagError = checkModeFlags(args.autoApprove, args.untilReview);
  if (flagError) throw new Error(flagError);
  const skip = parseSkipRoles(args.skipRoles);
  await ensureRepo(ROOT);
  if (!existsSync(join(ROOT, 'openspec'))) throw new Error(`в ${ROOT} нет openspec/: выполни agentflow init (или openspec init)`);
  const policy = loadPolicy(ROOT);
  const roles = loadRoles(ROOT);
  for (const w of mcpWarnings(policy, roles)) log.warn(w);
  for (const n of ROLES) if (!roles.has(n)) throw new Error(`нет файла роли ${n}.md ни в kit, ни в .agentflow/agents/`);
  const dirty = treeChanges(await changedPaths(ROOT));

  const intent = args.intent ? readIntent(args.intent) : undefined;
  const change = args.change ?? intent?.change;
  if (!change) throw new Error('укажи intent (файл или текст) и/или --change <id> существующего change');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(change)) throw new Error(`id change "${change}" должен быть kebab-case`);
  const mainChangeDir = join(ROOT, 'openspec/changes', change);
  const existing = existsSync(mainChangeDir);
  if (!intent && !existing) throw new Error(`change ${change} не найден в openspec/changes/: для нового change нужен intent`);
  const intentText = intent?.text ?? intentFromChange(mainChangeDir, change);
  const settings = await runSettings({ ...args, skip });
  NO_PANEL = !settings.panel;
  NO_MOUSE = !settings.mouse;

  const runStamp = stamp();
  const runId = `${runStamp}-${change}`;
  const runDir = join(ROOT, RUNS_DIR, runId);
  const branch = `${policy.git.branchPrefix}${change}${(await branchExists(ROOT, `${policy.git.branchPrefix}${change}`)) ? '-' + runStamp : ''}`;
  let wt = ROOT;
  let startBranch: string | undefined;
  let carry: string[] = [];
  if (settings.worktree) {
    mkdirSync(runDir, { recursive: true });
    wt = join(runDir, 'worktree');
    await addWorktree(ROOT, wt, branch);
    // Незакоммиченное состояние OpenSpec основного дерева (сам change, config, схемы) переносится в worktree.
    carry = dirty.filter((p) => p.startsWith('openspec/') && (!p.startsWith('openspec/changes/') || p.startsWith(`openspec/changes/${change}/`)));
    for (const p of carry) {
      const from = join(ROOT, p);
      if (!existsSync(from)) continue;
      mkdirSync(dirname(join(wt, p)), { recursive: true });
      cpSync(from, join(wt, p));
    }
    // Схемы и config в .gitignore не попадают ни в HEAD, ни в git status — без них OpenSpec в worktree схему не найдёт.
    for (const p of ['openspec/config.yaml', 'openspec/schemas']) {
      if (existsSync(join(ROOT, p))) cpSync(join(ROOT, p), join(wt, p), { recursive: true, force: false });
    }
    const otherDirty = dirty.filter((p) => !carry.includes(p));
    if (otherDirty.length) log.warn(`незакоммиченные изменения вне openspec/ не попадут в worktree: ${otherDirty.slice(0, 5).join(', ')}${otherDirty.length > 5 ? '…' : ''}`);
  } else {
    process.once('exit', lockTree(await gitPath(ROOT, TREE_LOCK), runId));
    // Каталог run лежит в дереве: без игнора он попал бы в коммиты контроллера и в проверку границ ACL.
    if (await ensureIgnored(ROOT, `${RUNS_DIR}/${runId}/state.json`, `/${RUNS_DIR}/`)) log.warn(`${RUNS_DIR}/ не в .gitignore — добавлен в .git/info/exclude (agentflow init добавит его в .gitignore)`);
    const foreign = foreignDirty(dirty, change);
    if (foreign.length) {
      log.warn(
        `незакоммиченные изменения вне change (${foreign.length}): ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? '…' : ''} — ` +
          'переходят на ветку run и попадут в первый коммит контроллера (freeze спеки)',
      );
    }
    startBranch = await currentBranch(ROOT);
    await switchNew(ROOT, branch);
    mkdirSync(runDir, { recursive: true });
  }
  const baseCommit = await head(wt);

  const store = new RunStore(runDir);
  const os = new OpenSpec(ROOT, wt);
  await os.ensureSchema(change, existing ? undefined : policy.openspec.schema || undefined);
  store.state = {
    runId,
    change,
    status: 'running',
    stage: 'clarify',
    step: 'init',
    createdAt: now(),
    updatedAt: now(),
    repoRoot: ROOT,
    worktree: wt,
    branch,
    ...(startBranch ? { startBranch } : {}),
    baseCommit,
    options: { autoApprove: settings.autoApprove, mock: args.mock, clarify: settings.clarify, inject: args.inject, skip: settings.skip, ...(settings.untilReview ? { untilReview: true } : {}), ...(settings.worktree ? { worktree: true } : {}) },
    versions: { prompts: promptsRevision(ROOT), policy: policy.sha, sdk: sdkVersion(), openspec: await os.version(), openspecBin: os.bin },
    stagesDone: [],
    intent: { source: intent?.source ?? `openspec/changes/${change}`, text: intentText, clarifications: [] },
    spec: { order: [], artifacts: {}, holisticPassed: false, questions: [] },
    apply: { batches: [] },
    findings: [],
    gates: [],
    loops: [],
    models: {},
    usage: {},
    decisions: [],
    proceeded: [],
    dialogs: {},
    injected: [],
  };
  store.save();
  writeFileSync(join(runDir, 'intent.md'), intentText + '\n');
  if (!existing) await os.newChange(change, policy.openspec.schema || undefined, intentText.split('\n')[0]!.slice(0, 120));

  const ctx = makeCtx(ROOT, runDir, store, policy, roles);
  writeManifest(ctx);
  log.phase(`agentflow · run ${runId}`);
  log.info(`репозиторий ${c.bold(ROOT)} · change ${c.bold(change)}${existing ? ' (существующий)' : ' (новый)'} · ветка ${branch}`);
  log.info(settings.worktree ? `worktree ${wt}${carry.length ? ` · перенесено незакоммиченное из openspec/: ${carry.length} файлов` : ''}` : `основное дерево ${wt}${startBranch ? ` · ветка run создана от ${startBranch}` : ''}`);
  log.info(`kit ${KIT} · policy: ${policy.sources.join(' + ')}`);
  log.info(`CLI: ${qwenExecutable(policy) ?? 'встроенный в SDK'} · SDK ${store.state.versions.sdk} · OpenSpec ${store.state.versions.openspec} (${os.bin})${args.mock ? c.yellow(' · MOCK-роли') : ''}`);
  for (const n of ROLES) {
    const r = roles.get(n)!;
    if (settings.skip.includes(n)) {
      log.info(c.gray(`  ${n.padEnd(18)} → выключена в настройках run`));
      continue;
    }
    log.info(`  ${n.padEnd(18)} → ${r.model} · effort ${policy.qwen.effortViaSdk ? r.effort ?? 'по умолчанию' : 'по умолчанию (effortViaSdk: false)'} · ${r.file}`);
  }
  if (args.inject.length) log.inject(`включены точки: ${args.inject.join(', ')}`);
  await pipeline(ctx);
}

/**
 * Настройки run: флаги, а в интерактивном терминале без --auto-approve, --auto-until-review и --skip-roles — меню с
 * галочками. Ошибка флага и отказ от меню — до создания ветки (и worktree).
 */
async function runSettings(args: { autoApprove: boolean; untilReview: boolean; clarify: boolean; worktree: boolean; skip: RunSettings['skip']; skipRoles?: string }): Promise<RunSettings> {
  const flags: RunSettings = { skip: args.skip, clarify: args.clarify, autoApprove: args.autoApprove, untilReview: args.untilReview, panel: !NO_PANEL, mouse: !NO_MOUSE, worktree: args.worktree };
  // Режим --auto-until-review — прогон без участия: меню ждало бы человека до старта.
  if (args.autoApprove || args.untilReview || args.skipRoles !== undefined || !process.stdin.isTTY || !process.stdout.isTTY) return flags;
  const picked = fromMenu(await new Human(false).checklist('Настройки run: пробел — отметить, Enter — запуск', settingsMenu(flags, process.env), validateMenu));
  const modeError = checkModeFlags(picked.autoApprove, picked.untilReview);
  if (modeError) throw new Error(modeError);
  return picked;
}

async function resumeRun(runId: string): Promise<void> {
  const runDir = join(ROOT, RUNS_DIR, runId);
  const store = new RunStore(runDir);
  if (!store.exists()) throw new Error(`нет run ${runId}`);
  store.load();
  if (store.state.status === 'accepted') {
    console.log(`run ${runId} уже принят`);
    return;
  }
  if (store.state.status === 'awaiting-review' && !process.stdin.isTTY) {
    console.log(`run ${runId} ждёт ревью человека на приёмке: запусти agentflow resume ${runId} в интерактивном терминале`);
    process.exitCode = 2;
    return;
  }
  if (inMainTree(store.state)) {
    // Run основного дерева продолжается только на своей ветке: иначе коммиты уйдут не туда.
    const cur = await currentBranch(ROOT);
    if (cur !== store.state.branch) {
      throw new Error(`run ${runId} работает в основном дереве на ветке ${store.state.branch}, а выбрана ${cur ?? 'detached HEAD'}: git switch ${store.state.branch} и снова resume`);
    }
    process.once('exit', lockTree(await gitPath(ROOT, TREE_LOCK), runId));
  }
  const policy = loadPolicy(ROOT);
  const roles = loadRoles(ROOT);
  for (const w of mcpWarnings(policy, roles)) log.warn(w);
  if (policy.sha !== store.state.versions.policy) log.warn('policy.yaml изменился с начала run — используется новая версия');
  store.state.status = 'running';
  store.state.stopReason = undefined;
  store.save();
  const ctx = makeCtx(ROOT, runDir, store, policy, roles);
  log.phase(`agentflow · resume ${runId} · этап ${store.state.stage}, шаг ${store.state.step}`);
  log.info(`пройдено: ${store.state.stagesDone.join(', ') || '—'}; незавершённый этап продолжается, принятое не переделывается`);
  await pipeline(ctx);
}

function showStatus(runId?: string): void {
  const runsDir = join(ROOT, RUNS_DIR);
  const ids = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, 'state.json'))).sort() : [];
  if (!runId) {
    if (!ids.length) console.log('запусков нет');
    for (const id of ids) {
      const s = JSON.parse(readFileSync(join(runsDir, id, 'state.json'), 'utf8')) as RunState;
      console.log(`${id}  ${s.status.padEnd(15)} этап ${s.stage}${s.stopReason ? ` — ${s.stopReason.split('\n')[0]}` : ''}`);
    }
    return;
  }
  const s = JSON.parse(readFileSync(join(runsDir, runId, 'state.json'), 'utf8')) as RunState;
  console.log(`${s.runId}: ${s.status} · этап ${s.stage} · шаг ${s.step}${s.stopReason ? `\nпричина: ${s.stopReason}` : ''}`);
  console.log(`findings: open ${s.findings.filter((f) => f.status === 'open').length}, closed ${s.findings.filter((f) => f.status === 'closed').length}, logged ${s.findings.filter((f) => f.status === 'logged').length}`);
  printLoopSummary(s);
}

function gateTemplate(repo: string): Record<string, string> {
  const todo = (op: string) => `echo "TODO: задай gates.ops.${op} в .agentflow/policy.yaml" >&2; exit 1`;
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    // не JS-проект: команды задаются вручную
  }
  const e2e = ['test:e2e', 'e2e', 'test:acceptance'].find((k) => scripts[k]);
  return {
    lint: scripts['lint'] ? 'npm run lint' : todo('lint'),
    unit: scripts['test'] ? 'npm test' : todo('unit'),
    e2e: e2e ? `npm run ${e2e}` : todo('e2e'),
  };
}

/** Подключить репозиторий к agentflow. Существующий OpenSpec (схема, changes) не трогается. */
async function initRepo(withSchema: boolean): Promise<void> {
  log.phase(`agentflow init · ${ROOT}`);
  const os = new OpenSpec(ROOT, ROOT);
  const configPath = join(ROOT, 'openspec/config.yaml');
  if (existsSync(join(ROOT, 'openspec'))) {
    const schema = existsSync(configPath) ? readFileSync(configPath, 'utf8').match(/^schema:\s*(\S+)/m)?.[1] : undefined;
    const changes = (await os.list().catch(() => [])).map((x) => x.name);
    log.info(`openspec/ уже есть — используется как есть: схема ${schema ?? 'по умолчанию OpenSpec'}, changes: ${changes.join(', ') || 'нет'}`);
  } else {
    const r = await exec(os.bin, ['init', '--tools', 'none', '--no-animation', '.'], { cwd: ROOT });
    if (r.code !== 0) throw new Error(`openspec init: ${r.stderr || r.stdout}`);
    log.step(`openspec init (${os.bin}): openspec/config.yaml, specs/, changes/`);
  }
  if (withSchema) {
    const dest = join(ROOT, 'openspec/schemas/agentflow');
    if (!existsSync(dest)) cpSync(join(KIT, 'openspec/schemas/agentflow'), dest, { recursive: true });
    log.step(`схема agentflow (spec-driven + test-plan) скопирована в ${dest}; чтобы сделать её схемой по умолчанию, поставь schema: agentflow в openspec/config.yaml`);
  }
  const policyPath = join(ROOT, '.agentflow/policy.yaml');
  if (existsSync(policyPath)) {
    log.info(`${policyPath} уже есть — не трогаю`);
  } else {
    const ops = gateTemplate(ROOT);
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(
      policyPath,
      [
        '# Настройки agentflow для этого репозитория. Накладываются поверх policy kit:',
        `#   ${join(KIT, '.agentflow/policy.yaml')}`,
        '# Объекты сливаются, списки заменяются. Роли и рубрики переопределяются файлами',
        '# .agentflow/agents/<роль>.md и .agentflow/rubrics/<id артефакта>.md (иначе — из kit).',
        '',
        '# Гейты: shell-команды проекта, выполняются в дереве run. Роли вызывают их как agentflow-gate <op>.',
        'gates:',
        '  ops:',
        ...Object.entries(ops).map(([op, cmd]) => `    ${op}: ${JSON.stringify(cmd)}`),
        '  batch: [lint, unit]',
        '  full: [lint, unit, e2e]',
        '',
        '# Acceptance-тесты: каталог (в нём же evidence/) и соглашения — уходят в промпт acceptance-tester.',
        'acceptance:',
        '  dir: e2e',
        '  framework: "TODO: фреймворк, расположение и запуск acceptance-тестов проекта"',
        '',
        '# Схема OpenSpec нового change: пусто — схема по умолчанию из openspec/config.yaml.',
        'openspec:',
        '  schema: ""',
        '',
        '# Пути, куда роли могут писать, — при необходимости переопредели:',
        '# roles:',
        '#   implementer:',
        '#     write: ["**"]',
        '#     denyWrite: ["openspec/**", "{acceptance}/**", ".agentflow/**", ".git/**", "node_modules/**", "package.json", "package-lock.json"]',
        '',
      ].join('\n'),
    );
    log.step(`создан ${policyPath}: gates.ops — ${Object.values(ops).join(' · ')}`);
  }
  const gi = join(ROOT, '.gitignore');
  const lines = ['.agentflow-runs/*/*', '!.agentflow-runs/*/ACCEPTANCE.md'];
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const add = lines.filter((l) => !cur.split('\n').includes(l));
  if (add.length) writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '# agentflow: каталоги запусков, в git только отчёт приёмки\n' + add.join('\n') + '\n');
  log.step(add.length ? '.gitignore: добавлены .agentflow-runs' : '.gitignore уже содержит .agentflow-runs');
  console.log(`\nДальше:\n  1. проверь gates.ops и acceptance в ${policyPath}\n  2. git add .agentflow .gitignore openspec && git commit -m "agentflow: init"\n  3. agentflow smoke  ·  agentflow run <intent.md>  ·  agentflow run --change <существующий-change>`);
}

/** Changes репозитория по OpenSpec и их прогоны конвейера. */
async function showChanges(): Promise<void> {
  const os = new OpenSpec(ROOT, ROOT);
  const runsDir = join(ROOT, RUNS_DIR);
  const runs = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, 'state.json'))) : [];
  const changes = await os.list();
  if (!changes.length) console.log('активных changes нет');
  for (const ch of changes) {
    const schema = (await os.status(ch.name).catch(() => undefined))?.schemaName ?? '?';
    const own = runs.filter((r) => r.endsWith(`-${ch.name}`)).sort();
    const last = own.length ? (JSON.parse(readFileSync(join(runsDir, own.at(-1)!, 'state.json'), 'utf8')) as RunState) : undefined;
    console.log(
      `${ch.name.padEnd(28)} схема ${schema.padEnd(14)} задачи ${ch.completedTasks}/${ch.totalTasks}  ` +
        (last ? `последний run ${last.runId}: ${last.status}, этап ${last.stage}` : 'прогонов не было — agentflow run --change ' + ch.name),
    );
  }
}

const USAGE = `agentflow — конвейер spec-driven разработки на Qwen Code (kit: ${KIT})

Работает в git-репозитории, из которого запущен (или --repo <путь>), с его OpenSpec:
схема из openspec/config.yaml или .openspec.yaml change, существующие changes, его версия openspec.

  agentflow init [--agentflow-schema]      подключить репозиторий: .agentflow/policy.yaml, .gitignore,
                                           openspec init, если OpenSpec ещё нет
  agentflow changes                        changes репозитория, их схемы и прогоны
  agentflow run <intent.md | "текст"> [--change <id>]   новый change по intent
  agentflow run --change <id>              существующий change: готовые артефакты — на ревью,
                                           недостающие пишет spec-author, выполненные задачи пропускаются
      --auto-approve     решения человека — рекомендуемые варианты (для прогонов без участия)
      --auto-until-review  автопилот до приёмки: спека, freeze и код без человека, блокирующие находки
                         не снимаются (нет waiver и перехода дальше); run ждёт приёмки (awaiting-review),
                         принять или отклонить — agentflow resume <run-id>
      --inject <точки>   fault injection: all или через запятую:
                           ${INJECT_HELP.join('\n                           ')}
      --mock             роли без моделей (только демо-проект kit)
      --no-clarify       пропустить шаг уточнения intent
      --worktree         работать в своём worktree (.agentflow-runs/<run>/worktree), а не в основном дереве;
                         по умолчанию run создаёт ветку agentflow/<change> в основном дереве, и правки видны
                         сразу; в основном дереве run один, в worktree — сколько угодно
      --skip-roles <р,р>  выключить роли без диалога настроек: spec-reviewer, implementer, code-reviewer,
                         acceptance-tester; без implementer run только со спекой — завершается на freeze,
                         code-reviewer и acceptance-tester выключаются вместе с ним
                         (в TTY без --auto-approve, --auto-until-review и --skip-roles — меню настроек с галочками:
                         роли, уточнение intent, оба автопилота, панель, мышь, worktree)
      --no-panel         без панели статуса внизу терминала (или AGENTFLOW_NO_PANEL=1)
      --no-mouse         без режима мыши: клик по размышлению не раскрывает текст (или AGENTFLOW_NO_MOUSE=1)
      --thinking-chars <N>  сколько символов размышления видно сразу, дальше — «Развернуть»
                         (по умолчанию ${THINKING_CHARS}, 0 — только строка «размышляет»; или AGENTFLOW_THINKING_CHARS)
  agentflow resume <run-id> [--no-panel] [--no-mouse] [--thinking-chars <N>]
  agentflow status [<run-id>]
  agentflow agents [<run-id>]              список субагентов: роль, сессия, модель из ответа API
  agentflow smoke                          smoke-тесты корпоративного CLI в этом репозитории
`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      change: { type: 'string' },
      'auto-approve': { type: 'boolean', default: false },
      'auto-until-review': { type: 'boolean', default: false },
      inject: { type: 'string' },
      mock: { type: 'boolean', default: false },
      'no-clarify': { type: 'boolean', default: false },
      worktree: { type: 'boolean', default: false },
      'skip-roles': { type: 'string' },
      'no-panel': { type: 'boolean', default: false },
      'no-mouse': { type: 'boolean', default: false },
      'thinking-chars': { type: 'string' },
      'agentflow-schema': { type: 'boolean', default: false },
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }
  ROOT = await resolveRepo(values.repo);
  NO_PANEL = values['no-panel'];
  NO_MOUSE = values['no-mouse'];
  configureThinking({ chars: parseThinkingChars(values['thinking-chars'], process.env) });
  if (cmd === 'init') {
    await initRepo(values['agentflow-schema']);
  } else if (cmd === 'changes') {
    await showChanges();
  } else if (cmd === 'run') {
    await startRun({ intent: arg, change: values.change, autoApprove: values['auto-approve'], untilReview: values['auto-until-review'], mock: values.mock, clarify: !values['no-clarify'], worktree: values.worktree, inject: parseInject(values.inject), skipRoles: values['skip-roles'] });
  } else if (cmd === 'resume') {
    if (!arg) throw new Error('укажи run-id (agentflow status)');
    await resumeRun(arg);
  } else if (cmd === 'status') {
    showStatus(arg);
  } else if (cmd === 'agents') {
    const runsDir = join(ROOT, RUNS_DIR);
    const id = arg ?? readdirSync(runsDir).filter((d) => !d.startsWith('smoke-') && existsSync(join(runsDir, d, 'events.jsonl'))).sort().pop();
    if (!id) throw new Error('запусков нет');
    console.log(`run ${id}\n`);
    showAgents(join(runsDir, id));
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(c.red(e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exitCode = 1;
});
