// Контроллер agentflow: детерминированный конечный автомат конвейера spec-driven разработки.
// Пять ролей только предлагают артефакты, код и вердикты; переходы, гейты, git и решения
// о прохождении принимает этот код. Каждая роль — отдельная сессия @qwen-code/sdk.
//
//   npm run agentflow -- run tasks/01-slugify.md [--auto-approve] [--inject all] [--mock]
//   npm run agentflow -- resume <run-id>
//   npm run agentflow -- status [<run-id>]
//   npm run agentflow -- agents [<run-id>]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import {
  acceptancePrompt,
  authorPrompt,
  clarifyPrompt,
  codeReviewPrompt,
  finalReviewPrompt,
  holisticPrompt,
  implementerPrompt,
  indexRequirements,
  loadRubric,
  parseTasks,
  specReviewPrompt,
  writeContext,
  type BaseCtx,
  type Requirement,
  type TaskBatch,
} from './context-builder.ts';
import { showAgents } from './agents.ts';
import { runGates, gatesSummary, type GateResult } from './gates.ts';
import { addWorktree, changedPaths, commitAll, diff, diffNoIndex, ensureRepo, head } from './git.ts';
import { Human } from './human.ts';
import { INJECT_HELP, Injector, parseInject } from './inject.ts';
import { c, log, setLogSink } from './log.ts';
import { runMock } from './mock.ts';
import { OpenSpec, topoOrder, type ArtifactNode } from './openspec.ts';
import { loadPolicy, qwenExecutable, type Policy } from './policy.ts';
import { printLoopSummary, writeAcceptanceReport } from './report.ts';
import { decide, countBySeverity, validateReview, type Decision, type Expectation, type Review, type ReviewFinding } from './review-validator.ts';
import { loadRoles, runRole, type RoleDef, type RoleResult, type RoleRuntime, type TaskMeta } from './roles.ts';
import { artifactFiles, artifactSnapshot, artifactText, codeSnapshot, specDigest } from './snapshot.ts';
import { RunStore, STAGES, type BatchState, type Finding, type RunState, type Stage } from './state.ts';
import { Blocked, exec, extractJson, matchesAny, now, oneLine, sha256, short, stamp } from './util.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ROLE_NAMES = ['spec-author', 'spec-reviewer', 'implementer', 'code-reviewer', 'acceptance-tester'];

interface Ctx {
  root: string;
  wt: string;
  runDir: string;
  contextsDir: string;
  reviewsDir: string;
  gatesDir: string;
  store: RunStore;
  policy: Policy;
  roles: Map<string, RoleDef>;
  os: OpenSpec;
  rt: RoleRuntime;
  human: Human;
  inject: Injector;
  graph: ArtifactNode[];
}

const st = (ctx: Ctx): RunState => ctx.store.state;
const changeDir = (ctx: Ctx) => `openspec/changes/${st(ctx).change}`;
const changeDirAbs = (ctx: Ctx) => join(ctx.wt, changeDir(ctx));
const base = (ctx: Ctx): BaseCtx => ({ change: st(ctx).change, changeDir: changeDir(ctx), intent: st(ctx).intent.text, clarifications: st(ctx).intent.clarifications });
const node = (ctx: Ctx, id: string) => ctx.graph.find((n) => n.id === id)!;

// ───────────────────────────── вызовы ролей ─────────────────────────────

function role(ctx: Ctx, name: string): RoleDef {
  const r = ctx.roles.get(name);
  if (!r) throw new Error(`нет роли ${name} в .qwen/agents/`);
  return r;
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

/** Серия повторов закончилась ошибкой: человек решает, повторить ещё серию или остановить run. */
async function infraExhausted(ctx: Ctx, what: string, error: string, series: number): Promise<void> {
  const k = await ctx.human.select({
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
  for (let series = 1; ; series++) {
    let lastError = '';
    for (let attempt = 1; attempt <= tries; attempt++) {
      const res = await runRole(ctx.rt, { role: r, prompt, label: opts.label, cwd: ctx.wt, readOnly: opts.readOnly, resume: attempt === 1 && series === 1 ? opts.resume : undefined, meta });
      account(ctx, r, res);
      if (res.ok) return res;
      lastError = res.error ?? 'неизвестная ошибка';
      log.warn(`${name}: ошибка шага (${lastError}) — попытка ${attempt}/${tries}`);
    }
    await infraExhausted(ctx, `${opts.label}: роль ${name}`, lastError, series);
  }
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
  for (let series = 1; ; series++) {
    let lastError = '';
    for (let attempt = 1; attempt <= tries; attempt++) {
      const p = lastError
        ? `${prompt}\n\n## Предыдущий ответ отклонён валидатором контракта\n${lastError}\nВерни ответ строго по контракту.`
        : prompt;
      const tag = series === 1 && attempt === 1 ? label : `${label}-retry${series}.${attempt}`;
      writeContext(ctx.contextsDir, tag, p);
      const res = await runRole(ctx.rt, { role: r, prompt: p, label, cwd: ctx.wt, meta });
      account(ctx, r, res);
      if (!res.ok) {
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
function applyReview(ctx: Ctx, loop: string, round: number, review: Review, d: Decision): void {
  const prev = openFindings(ctx, loop);
  const raised = new Set(review.findings.map((f) => f.id));
  for (const p of prev) if (!raised.has(p.id) && p.source === review.role) p.status = 'closed';
  for (const f of review.findings) {
    const existing = prev.find((p) => p.id === f.id && p.source === review.role);
    const blocking = d.blocking.includes(f);
    // Спор о безопасности или утверждённом поведении LLM не прощает.
    if (existing?.status === 'disputed' && blocking && (f.category === 'security' || f.category === 'behavior')) {
      throw new Blocked(`${loop}: спор по находке ${f.id} (${f.category}) — нужно решение человека: ${f.problem}`);
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
  const out: Finding[] = [];
  const files = artifactFiles(changeDirAbs(ctx), n.outputPath);
  const vf = (problem: string, location: string) => synthetic(ctx, loop, round, 'validator', { problem, location, evidence: 'детерминированная валидация контроллера' });
  if (!files.length) out.push(vf(`не создан ни один файл ${n.outputPath}`, `${changeDir(ctx)}/${n.outputPath}`));
  const status = (await ctx.os.artifacts(st(ctx).change)).find((a) => a.id === n.id);
  if (files.length && status?.status !== 'done') out.push(vf(`openspec status: артефакт в статусе ${status?.status}`, `${changeDir(ctx)}/${n.outputPath}`));
  const specsReady = n.id === 'specs' || st(ctx).spec.artifacts['specs']?.status === 'accepted';
  if (files.length && specsReady) {
    const v = await ctx.os.validate(st(ctx).change);
    if (!v.valid) {
      const errors = v.issues.filter((i) => i.level === 'ERROR');
      for (const i of errors.length ? errors : v.issues) out.push(vf(`openspec validate --strict: ${i.message}`, `${changeDir(ctx)}/${i.path}`));
    }
  }
  if (n.id === 'tasks' && files.length) {
    const batches = parseTasks(readFileSync(join(changeDirAbs(ctx), 'tasks.md'), 'utf8'));
    if (!batches.length) out.push(vf('tasks.md: нет групп "## N. Название" с задачами "- [ ] N.M описание"', `${changeDir(ctx)}/tasks.md`));
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
      q.answer = await ctx.human.question(q);
      s.decisions.push({ at: now(), gate: `question:${n.id}`, decision: q.answer, comment: q.question });
      answered.push(humanFinding(ctx, n, `Решение человека по вопросу «${q.question}»: ${q.answer}`, 'Отрази решение в артефакте и согласуй с ним остальные разделы'));
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
  const [recommended, rationale] = validatorOnly
    ? (['hint', 'не проходит детерминированная валидация OpenSpec — автору нужен точный ориентир'] as const)
    : disputed
      ? (['waive', 'автор оспорил все оставшиеся находки с доказательствами — спор решаешь ты'] as const)
      : stuck(history)
        ? (['hint', 'одни и те же находки два раунда подряд — автор не сходится без твоего ориентира'] as const)
        : (['more', 'находки меняются от раунда к раунду — автор сходится'] as const);
  for (;;) {
    const k = await ctx.human.select({
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
    });
    if (k === 'show') {
      showArtifact(ctx, n);
      continue;
    }
    st(ctx).decisions.push({ at: now(), gate: `exhausted:${n.id}`, decision: k });
    ctx.store.save();
    if (k === 'more') return { action: 'continue', toFix, reviewOnly: false };
    if (k === 'stop') throw new Blocked(`артефакт ${n.id}: остановлено человеком после ${round} раундов`);
    if (k === 'self') {
      if (await ctx.human.waitForEdit(filesOf(ctx, n).map((f) => join(ctx.wt, f)))) return { action: 'continue', toFix: [], reviewOnly: true };
      continue;
    }
    if (k === 'hint') {
      const text = await ctx.human.text(`Указание для spec-author по «${n.id}»`, 'Сосредоточься на находках ревьюера; если находка неверна — ответь disputed с доказательством');
      return { action: 'continue', toFix: [...toFix, humanFinding(ctx, n, `Указание человека: ${text}`)], reviewOnly: false };
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
  const s = st(ctx);
  const loop = `artifact:${n.id}`;
  const a = (s.spec.artifacts[n.id] ??= { status: 'pending', rounds: 0 });
  a.status = 'pending';
  ctx.store.save();
  const max = ctx.policy.limits.artifactRounds;
  let budget = max;
  let toFix = seed;
  let session: string | undefined;
  let reviewOnly = !!opts.reviewFirst;
  const history: string[][] = [];
  for (let round = 1; ; round++) {
    a.rounds++;
    ctx.store.save();
    log.loopOpen(`артефакт ${n.id}`, round, Math.max(budget, round));
    const before = artifactText(changeDirAbs(ctx), n.outputPath);

    if (reviewOnly) {
      log.step('редакция изменилась вне автора (ты или upstream): ревью без генерации');
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
        rubric: loadRubric(ctx.wt, n.id),
        findings: toFix,
        exists: artifactFiles(changeDirAbs(ctx), n.outputPath).length > 0,
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
      const rubric = loadRubric(ctx.wt, n.id);
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

      const d = honorWaivers(ctx, loop, snap, decide(review, 'spec'));
      applyReview(ctx, loop, round, review, d);
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
        const k = await ctx.human.select({
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
        if (k === 'stop') throw new Blocked(`артефакт ${n.id}: ${d.reason}`);
        if (k === 'self') {
          if (await ctx.human.waitForEdit(filesOf(ctx, n).map((f) => join(ctx.wt, f)))) reviewOnly = true;
        } else {
          const text = await ctx.human.text('Недостающий контекст', 'используй intent и код репозитория как единственный источник');
          s.intent.clarifications.push({ question: `контекст для ${n.id}: ${d.reason}`, answer: text });
          toFix = [humanFinding(ctx, n, `Контекст от человека: ${text}`)];
        }
        budget = round + max;
        continue;
      }

      if (d.verdict === 'PASS') {
        log.verdict('PASS', counts, 'твоё ревью артефакта');
        log.loopClose(`ревьюер принял «${n.id}» на раунде ${round}`);
        const g = await artifactGate(ctx, n, snap, round);
        if (g.kind === 'accept') {
          a.status = 'accepted';
          a.snapshot = snap;
          ctx.store.save();
          log.info(c.green(`«${n.id}» принят тобой · snapshot ${short(snap)}`));
          return;
        }
        if (g.kind === 'self') reviewOnly = true;
        else toFix = g.findings;
        budget = round + max;
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
    const rubric = loadRubric(ctx.wt, 'holistic');
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
    const d = honorWaivers(ctx, 'holistic', snap, decide(review, 'spec'));
    applyReview(ctx, 'holistic', round, review, d);
    collectQuestions(ctx, 'spec-reviewer', 'proposal', d.human.map((f) => ({ question: f.problem, why: f.evidence, options: [{ label: f.requiredChange ?? 'Как предлагает ревьюер' }, { label: 'Оставить как есть' }], recommended: 0, rationale: 'решение, которое предложил ревьюер', artifact: f.artifact ?? artifactOfLocation(ctx, f.location) })));
    ctx.store.loop('holistic', round, d.verdict, d.reason);
    if (d.verdict === 'BLOCKED') {
      log.verdict('BLOCKED', d.reason, 'остановка run');
      log.loopClose('BLOCKED');
      throw new Blocked(`сквозное ревью: ${d.reason}`);
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
      const k = await ctx.human.select({
        title: `Сквозное ревью: ${round} раунда без PASS`,
        context: blocking.map((f) => `${f.id} [${f.severity}] → ${f.artifact ?? artifactOfLocation(ctx, f.location) ?? '?'}: ${oneLine(f.problem, 110)}`),
        options: [
          { key: 'more', label: 'Ещё раунд: исправить артефакты по находкам', description: 'петли артефактов с твоим ревью, затем сквозное ревью' },
          { key: 'waive', label: 'Снять оставшиеся находки сквозного ревью с причиной (waiver)' },
          { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)' },
        ],
        recommended: stuck(history) ? 'waive' : 'more',
        rationale: stuck(history) ? 'те же находки повторяются после исправлений — вероятно, спорные; реши сам' : 'находки меняются — пакет сходится',
      });
      s.decisions.push({ at: now(), gate: 'exhausted:holistic', decision: k });
      if (k === 'stop') throw new Blocked(`сквозное ревью: остановлено человеком после ${round} раундов`);
      if (k === 'waive') {
        waive(ctx, blocking, await ctx.human.text('Причина waiver', 'принято человеком: не блокирует реализацию'), snap);
        s.spec.holisticPassed = true;
        s.spec.holisticDigest = snap;
        ctx.store.save();
        return;
      }
      budget = round + 1;
    }
    // Находки остаются open: следующий раунд сквозного ревью закроет их или повторит.
    await reaccept(ctx, groups);
  }
}

async function stageClarify(ctx: Ctx): Promise<void> {
  if (!st(ctx).options.clarify) return;
  log.phase('ФАЗА СПЕКИ · уточнение intent');
  ctx.store.setStep('clarify');
  const res = await callRole(ctx, 'spec-author', clarifyPrompt(base(ctx)), { kind: 'clarify' }, { label: 'clarify', readOnly: true });
  const j = extractJson(res.text) as { questions?: QuestionItem[] } | undefined;
  const qs = (j?.questions ?? []).filter((q) => q.question);
  if (!qs.length) log.step('уточнений не требуется');
  for (const q of qs) {
    const options = (q.options ?? []).map((o) => (typeof o === 'string' ? { label: o } : { label: String(o.label ?? ''), description: o.description }));
    const answer = await ctx.human.question({ ...q, options });
    st(ctx).intent.clarifications.push({ question: q.question, answer });
  }
  ctx.store.save();
}

async function stageSpec(ctx: Ctx): Promise<void> {
  log.phase(`ФАЗА СПЕКИ · артефакты по графу схемы: ${ctx.graph.map((n) => n.id).join(' → ')}`);
  for (const n of ctx.graph) {
    const a = st(ctx).spec.artifacts[n.id];
    if (a?.status === 'accepted' && a.snapshot === snapshotOf(ctx, n)) continue;
    await artifactLoop(ctx, n, [], { reviewFirst: a?.status === 'accepted' });
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
  if (!s.spec.holisticPassed || s.spec.holisticDigest !== currentDigest(ctx)) out.push('сквозное ревью не пройдено на текущей редакции пакета');
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
        q.answer = await ctx.human.question(q);
        s.decisions.push({ at: now(), gate: 'approval:question', decision: q.answer, comment: q.question });
        const n = node(ctx, q.artifact) ?? ctx.graph[0]!;
        groups.set(n.id, [...(groups.get(n.id) ?? []), humanFinding(ctx, n, `Решение человека по вопросу «${q.question}»: ${q.answer}`, 'Отрази решение в артефакте')]);
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
      title: 'Заморозить спеку и запустить apply?',
      context: [
        ...ctx.graph.map((n) => `✓ ${n.id.padEnd(10)} раундов ${s.spec.artifacts[n.id]!.rounds} · ${short(s.spec.artifacts[n.id]!.snapshot ?? '')} · ${filesOf(ctx, n).join(', ')}`),
        `сквозное ревью PASS · openspec validate --strict чист · digest ${short(currentDigest(ctx))}`,
        ...(waived.length ? [`снято waiver: ${waived.map((f) => f.id).join(', ')}`] : []),
        ...(logged.length ? [`minor/nit в журнале: ${logged.length}`] : []),
      ],
      options: [
        { key: 'freeze', label: 'Заморозить и перейти к apply', description: 'дальше конвейер меняет только код и тесты в рамках контракта' },
        { key: 'revise', label: 'Вернуть артефакт на доработку', description: 'выбрать артефакт и дать замечание; ниже по графу — повторное ревью' },
        { key: 'stop', label: 'Остановить run (BLOCKED, потом resume)' },
      ],
      recommended: 'freeze',
      rationale: 'все условия freeze выполнены: артефакты приняты тобой на текущих редакциях, сквозное ревью и validate чистые',
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
  log.info('дальше конвейер меняет только код и тесты в рамках утверждённого контракта');
}

// ───────────────────────────── фаза apply ─────────────────────────────

function requirements(ctx: Ctx): Requirement[] {
  return indexRequirements(changeDirAbs(ctx), changeDir(ctx));
}

function specFiles(ctx: Ctx): string[] {
  return ctx.graph.flatMap((n) => artifactFiles(changeDirAbs(ctx), n.outputPath).map((f) => `${changeDir(ctx)}/${f}`));
}

/** Изменённые файлы против ACL роли: защита второй линии поверх canUseTool. */
async function checkBoundary(ctx: Ctx, roleName: string): Promise<void> {
  const rp = ctx.policy.roles[roleName]!;
  const sub = (g: string) => g.replaceAll('{change}', st(ctx).change);
  const bad = (await changedPaths(ctx.wt)).filter((p) => !matchesAny(p, rp.write.map(sub)) || matchesAny(p, (rp.denyWrite ?? []).map(sub)));
  if (bad.length) throw new Blocked(`${roleName} изменил файлы вне своих полномочий: ${bad.join(', ')}`);
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
  if (j?.['status'] === 'NEEDS_SPEC_CHANGE') throw new Blocked(`implementer: спеку нужно изменить — ${String(j['specIssue'] ?? 'без описания')}`);

  const attempts = ctx.policy.limits.gateAttempts;
  let gates: GateResult[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    ctx.store.setStep(`apply:${a.label}:gates:${attempt}`);
    await checkBoundary(ctx, 'implementer');
    log.step(`гейты ${ctx.policy.gates.batch.join(', ')} · попытка ${attempt}/${attempts}`);
    gates = await runGates(ctx.policy.gates.batch, {
      cwd: ctx.wt,
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

/** Автоматические раунды батча или финала кончились: что дальше — решаешь ты. */
async function applyExhausted(
  ctx: Ctx,
  what: string,
  round: number,
  toFix: Finding[],
  history: string[][],
  gateFailed: boolean,
): Promise<{ kind: 'more' | 'fresh'; hint?: string }> {
  const [recommended, rationale] = gateFailed
    ? (['fresh', 'гейты красные после всех попыток — нужен свежий контекст и сводка провалов'] as const)
    : stuck(history)
      ? (['hint', 'одни и те же находки два раунда подряд — implementer не сходится без твоего ориентира'] as const)
      : (['more', 'находки меняются от раунда к раунду — implementer сходится'] as const);
  const k = await ctx.human.select({
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
  });
  st(ctx).decisions.push({ at: now(), gate: `exhausted:${what}`, decision: k });
  ctx.store.save();
  if (k === 'stop') throw new Blocked(`${what}: остановлено человеком после ${round} раундов`);
  if (k === 'spec') throw new Blocked(`${what}: нужна правка замороженной спеки — исправь артефакты и согласуй заново (новый run)`);
  if (k === 'hint') return { kind: 'more', hint: await ctx.human.text('Указание для implementer', 'Сначала исправь блокирующие находки ревьюера, ничего вне батча не трогай') };
  return { kind: k };
}

/** Петля task batch: реализация → гейты → коммит → ревью кода; после лимита решаешь ты. */
async function batchLoop(ctx: Ctx, b: BatchState): Promise<void> {
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
      let fixDiffPath: string | undefined;
      if (round > 1 && prevHead !== headSha) {
        fixDiffPath = join(ctx.contextsDir, `${label}-fix.diff`);
        writeFileSync(fixDiffPath, await diff(ctx.wt, prevHead, headSha));
      }
      const snap = codeSnapshot(b.base, headSha, diffText);
      log.step(`коммит ${headSha.slice(0, 10)} · snapshot кода ${short(snap)} (base ${b.base.slice(0, 8)} → head ${headSha.slice(0, 8)})`);

      ctx.store.setStep(`apply:${b.id}:review`);
      const rubric = loadRubric(ctx.wt, 'batch');
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
      if ((await head(ctx.wt)) !== headSha || (await changedPaths(ctx.wt)).length) throw new Blocked(`batch ${b.id}: код изменился во время ревью — вердикт недействителен`);
      if (ctx.inject.repeat(`batch-stuck:${b.id}`, max)) review = injectRevise(review, `${diffPath}:1`, round, 'INJ-STUCK');
      else if (ctx.inject.take(`batch-revise:${b.id}`)) review = injectRevise(review, `${diffPath}:1`, round);

      const d = decide(review, 'apply');
      applyReview(ctx, loop, round, review, d);
      ctx.store.loop(loop, round, d.verdict, d.reason);
      const counts = countBySeverity(review.findings);
      if (d.verdict === 'BLOCKED') {
        log.verdict('BLOCKED', d.reason, 'остановка run');
        log.loopClose('BLOCKED');
        throw new Blocked(`batch ${b.id}: ${d.reason}`);
      }
      if (d.verdict === 'PASS') {
        b.status = 'done';
        b.head = headSha;
        for (const t of b.tasks) t.done = true;
        ctx.store.save();
        log.verdict('PASS', counts, 'батч принят');
        log.loopClose(`batch ${b.id} принят на раунде ${round}`);
        return;
      }
      failures.push(`раунд ${round}: ${d.blocking.map((f) => `${f.id} ${f.problem}`).join('; ')}`);
      log.verdict('REVISE', counts, round < budget ? `раунд ${round + 1}: ${round + 1 === 3 ? 'новый implementer' : 'та же сессия implementer'}` : 'автоматические раунды кончились');
      log.loopClose('REVISE');
      toFix = stored(ctx, loop, d.blocking);
      history.push(toFix.map((f) => f.id));
      prevHead = headSha;
    }
    if (round < budget) continue;
    const ex = await applyExhausted(ctx, `batch ${b.id}`, round, toFix, history, gateFailed);
    budget = round + 1;
    if (ex.kind === 'fresh') fresh = true;
    if (ex.hint) toFix = [...toFix, synthetic(ctx, loop, round, 'human', { problem: `Указание человека: ${ex.hint}`, location: 'batch', evidence: 'решение человека' })];
  }
}

async function stageApply(ctx: Ctx): Promise<void> {
  log.phase('ФАЗА APPLY · task batches по tasks.md');
  verifyFreeze(ctx);
  const s = st(ctx);
  if (!s.apply.batches.length) {
    const batches = parseTasks(readFileSync(join(changeDirAbs(ctx), 'tasks.md'), 'utf8'));
    s.apply.batches = batches.map((b) => ({ id: b.id, title: b.title, tasks: b.tasks.map((t) => ({ ...t, done: false })), status: 'pending', rounds: 0 }));
    ctx.store.save();
  }
  log.info(`батчей: ${s.apply.batches.length} — ${s.apply.batches.map((b) => `${b.id}. ${b.title}`).join('; ')}`);
  for (const b of s.apply.batches) if (b.status !== 'done') await batchLoop(ctx, b);
  log.info(c.green('все батчи PASS → acceptance'));
}

// ───────────────────────────── acceptance и финал ─────────────────────────────

async function runAcceptance(ctx: Ctx, extra: Finding[], label: string): Promise<Decision> {
  verifyFreeze(ctx);
  const snap = st(ctx).spec.freeze!.digest;
  const reqs = requirements(ctx);
  const scenarioIds = reqs.flatMap((r) => r.scenarios.map((x) => x.id));
  const rubric = loadRubric(ctx.wt, 'acceptance');
  const testPlan = `${changeDir(ctx)}/test-plan.md`;
  let prompt = acceptancePrompt(base(ctx), { reqs, specFiles: specFiles(ctx), testPlan, snapshotId: snap, rubric });
  if (extra.length) prompt += `\n\n## Находки финального ревью к твоим тестам\n${extra.map((f) => `- ${f.id} ${f.location}: ${f.problem}`).join('\n')}\nИсправь тесты, не ослабляя ожидаемое поведение.`;
  const review = await callReviewer(
    ctx,
    'acceptance-tester',
    prompt,
    { kind: 'acceptance', snapshotId: snap, round: 1, checks: scenarioIds, target: 'acceptance', requirements: reqs },
    { role: 'acceptance-tester', target: 'acceptance', snapshotId: snap, round: 1, mandatoryChecks: scenarioIds },
    label,
  );
  await checkBoundary(ctx, 'acceptance-tester');
  const commit = await commitAll(ctx.wt, `agentflow(${st(ctx).change}): acceptance-тесты`);
  if (existsSync(join(ctx.wt, 'e2e/evidence'))) cpSync(join(ctx.wt, 'e2e/evidence'), join(ctx.runDir, 'evidence'), { recursive: true });
  const d = decide(review, 'apply');
  applyReview(ctx, 'acceptance', 1, review, d);
  ctx.store.loop('acceptance', 1, d.verdict, d.reason);
  writeFileSync(join(ctx.contextsDir, 'acceptance-report.json'), JSON.stringify(review, null, 2));
  st(ctx).acceptance = { status: d.verdict, snapshot: snap, report: review };
  ctx.store.save();
  const passed = review.checks.filter((x) => x.result === 'PASS').length;
  log.verdict(d.verdict, `сценариев PASS ${passed}/${review.checks.length} · коммит ${commit.slice(0, 10)}`, d.verdict === 'BLOCKED' ? 'остановка run' : 'полные гейты и финальное ревью');
  if (d.verdict === 'BLOCKED') throw new Blocked(`acceptance: ${d.reason}`);
  return d;
}

async function stageAcceptance(ctx: Ctx): Promise<void> {
  log.phase('ACCEPTANCE · acceptance-tester по замороженной спеке');
  await runAcceptance(ctx, [], 'acceptance');
}

/** Финальное ревью: полные гейты → ревью с трассировкой; ≤ finalFixRounds раундов исправлений. */
async function stageFinal(ctx: Ctx): Promise<void> {
  log.phase('ФИНАЛ · полные гейты и финальное ревью трассировки');
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
    const gates = await runGates(ctx.policy.gates.full, { cwd: ctx.wt, logDir: ctx.gatesDir, step: `final-r${round}` });
    recordGates(ctx, gates);
    const headSha = await commitAll(ctx.wt, `agentflow(${s.change}): финальные гейты`);
    const diffText = await diff(ctx.wt, s.apply.base!, headSha);
    const diffPath = join(ctx.contextsDir, `final-r${round}.diff`);
    writeFileSync(diffPath, diffText);
    const snap = codeSnapshot(s.apply.base!, headSha, diffText);
    log.step(`snapshot ${short(snap)} · head ${headSha.slice(0, 10)}`);
    const reqs = requirements(ctx);
    const rubric = loadRubric(ctx.wt, 'final');
    ctx.store.setStep('final:review');
    let review = await callReviewer(
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
        rubric,
        snapshotId: snap,
        prior: openFindings(ctx, loop),
      }),
      { kind: 'final-review', snapshotId: snap, round, checks: rubric.mandatory, target: 'final', requirements: reqs },
      { role: 'code-reviewer', target: 'final', snapshotId: snap, round, mandatoryChecks: rubric.mandatory, needAssessments: true, requireTrace: reqs.map((r) => r.id) },
      `final-r${round}-review`,
    );
    if (ctx.inject.take('final-revise')) review = injectRevise(review, 'src/index.js:1', round);
    const d = decide(review, 'apply');
    applyReview(ctx, loop, round, review, d);
    ctx.store.loop(loop, round, d.verdict, d.reason);
    if (d.verdict === 'BLOCKED') {
      log.verdict('BLOCKED', d.reason, 'остановка run');
      log.loopClose('BLOCKED');
      throw new Blocked(`финальное ревью: ${d.reason}`);
    }
    if (d.verdict === 'PASS') {
      s.final = { status: 'PASS', snapshot: snap, rounds: round, traceability: review.traceability ?? [] };
      ctx.store.save();
      log.verdict('PASS', countBySeverity(review.findings), 'отчёт приёмки');
      log.loopClose('финальное ревью пройдено');
      return;
    }
    const blocking = stored(ctx, loop, d.blocking);
    history.push(blocking.map((f) => f.id));
    if (round >= budget) {
      log.verdict('REVISE', countBySeverity(review.findings), 'автоматические раунды исправлений кончились');
      const ex = await applyExhausted(ctx, 'финальное ревью', round, blocking, history, !gates.every((g) => g.ok));
      budget = round + 1;
      hint = ex.hint;
    }
    if (hint) blocking.push(synthetic(ctx, loop, round, 'human', { problem: `Указание человека: ${hint}`, location: 'final', evidence: 'решение человека' }));
    hint = undefined;
    const e2e = blocking.filter((f) => f.location.startsWith('e2e/'));
    const code = blocking.filter((f) => !f.location.startsWith('e2e/'));
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
  const p = join(changeDirAbs(ctx), 'test-plan.md');
  if (!existsSync(p)) return '';
  const m = readFileSync(p, 'utf8').split(/^## /m).find((x) => x.startsWith('Manual check'));
  return m ? `В каталоге \`${ctx.wt}\`:\n\n${m.replace(/^Manual check\s*/, '').trim()}` : '';
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
  const acc = s.acceptance?.report as { checks?: { result: string }[] } | undefined;
  const passed = acc?.checks?.filter((x) => x.result === 'PASS').length ?? 0;
  const total = acc?.checks?.length ?? 0;
  const mc = manualCheck(ctx);
  const k = await ctx.human.select({
    title: 'Принять change?',
    context: [
      `отчёт: ${join(ctx.runDir, 'ACCEPTANCE.md')}`,
      `код для ручного теста: ${ctx.wt} (ветка ${s.branch})`,
      `финальное ревью ${s.final?.status ?? '—'} · acceptance ${passed}/${total} сценариев PASS`,
      ...(mc ? [mc.replace(/\n+/g, ' · ')] : []),
    ],
    options: [
      { key: 'accept', label: 'Принять → openspec archive', description: 'дельты спеки переносятся в openspec/specs, merge — вне конвейера' },
      { key: 'reject', label: 'Отклонить', description: 'run завершается со статусом rejected, причина — в отчёт' },
    ],
    recommended: 'accept',
    rationale: `финальное ревью PASS, ${passed}/${total} acceptance-сценариев прошли — осталась твоя ручная проверка`,
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

async function stageArchive(ctx: Ctx): Promise<void> {
  log.phase('ARCHIVE');
  const tasksPath = join(changeDirAbs(ctx), 'tasks.md');
  const done = new Set(st(ctx).apply.batches.flatMap((b) => b.tasks.filter((t) => t.done).map((t) => t.id)));
  // Прогресс жил в state.json; галочки ставятся только перед archive (digest их нормализует).
  writeFileSync(tasksPath, readFileSync(tasksPath, 'utf8').replace(/^(\s*- )\[ \](\s+(\d+\.\d+))/gm, (m, a: string, b: string, id: string) => (done.has(id) ? `${a}[x]${b}` : m)));
  const out = await ctx.os.archive(st(ctx).change);
  log.step(out.trim().split('\n').slice(-3).join(' · '));
  const commit = await commitAll(ctx.wt, `agentflow(${st(ctx).change}): archive`);
  st(ctx).status = 'accepted';
  ctx.store.save();
  writeAcceptanceReport(ctx.runDir, st(ctx), manualCheck(ctx));
  log.info(c.green(`change принят и заархивирован · коммит ${commit.slice(0, 10)} в ветке ${st(ctx).branch}`));
  log.info(`merge вне конвейера: git merge ${st(ctx).branch}`);
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

function promptsRevision(root: string): string {
  const files = [
    ...readdirSync(join(root, '.qwen/agents')).map((f) => join(root, '.qwen/agents', f)),
    ...readdirSync(join(root, '.agentflow/rubrics')).map((f) => join(root, '.agentflow/rubrics', f)),
  ].sort();
  return sha256(files.map((f) => readFileSync(f, 'utf8')).join('\n'));
}

function sdkVersion(root: string): string {
  try {
    return (JSON.parse(readFileSync(join(root, 'node_modules/@qwen-code/sdk/package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function writeManifest(ctx: Ctx): void {
  const s = st(ctx);
  const manifest = {
    run: { id: s.runId, change: s.change, createdAt: s.createdAt, mock: s.options.mock, inject: s.options.inject },
    qwen: { executable: qwenExecutable(ctx.policy) ?? 'bundled', sdkVersion: s.versions.sdk, effortViaSdk: ctx.policy.qwen.effortViaSdk },
    openspec: { version: s.versions.openspec, schema: ctx.policy.openspec.schema },
    git: { branch: s.branch, worktree: s.worktree, base: s.baseCommit },
    models: Object.fromEntries(
      ROLE_NAMES.map((n) => {
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
  setLogSink((e) => store.append(e));
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
    reviewsDir,
    gatesDir,
    store,
    policy,
    roles,
    os: new OpenSpec(root, s.worktree),
    rt,
    human: new Human(s.options.autoApprove),
    inject: new Injector(store),
    graph: [],
  };
}

async function pipeline(ctx: Ctx): Promise<void> {
  const s = st(ctx);
  ctx.graph = topoOrder(await ctx.os.artifacts(s.change));
  s.spec.order = ctx.graph.map((n) => n.id);
  ctx.store.save();
  try {
    for (const stage of STAGES) {
      if (s.stagesDone.includes(stage)) continue;
      s.stage = stage;
      ctx.store.save();
      await STAGE_FN[stage](ctx);
      s.stagesDone.push(stage);
      ctx.store.save();
      if (ctx.inject.take(`kill-after:${stage}`)) {
        log.error(`контроллер убит после этапа ${stage}; продолжи: npm run agentflow -- resume ${s.runId}`);
        process.exit(137);
      }
    }
    printLoopSummary(s);
    console.log('\n' + c.green(c.bold(`✔ run ${s.runId}: change ${s.change} принят`)));
  } catch (e) {
    if (!(e instanceof Blocked)) {
      s.status = 'failed';
      s.stopReason = e instanceof Error ? e.stack ?? e.message : String(e);
      ctx.store.save();
      throw e;
    }
    if (s.status === 'running') s.status = 'blocked';
    s.stopReason = e.message;
    ctx.store.save();
    log.error(`${s.status.toUpperCase()}: ${e.message}`);
    writeAcceptanceReport(ctx.runDir, s, manualCheck(ctx));
    writeManifest(ctx);
    printLoopSummary(s);
    console.log(`\nпричина записана в ${ctx.store.statePath}; продолжить после исправления: npm run agentflow -- resume ${s.runId}`);
    process.exitCode = 2;
  }
}

function readIntent(arg: string): { text: string; change?: string; source: string } {
  const path = resolve(process.cwd(), arg);
  if (!existsSync(path)) return { text: arg, source: 'argv' };
  const raw = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const change = m?.[1]?.match(/^change:\s*([\w-]+)\s*$/m)?.[1];
  const fallback = basename(path, '.md').replace(/^\d+[-_]/, '');
  return { text: (m ? m[2]! : raw).trim(), change: change ?? fallback, source: arg };
}

async function startRun(args: { intent: string; change?: string; autoApprove: boolean; mock: boolean; clarify: boolean; inject: string[] }): Promise<void> {
  await ensureRepo(ROOT);
  const policy = loadPolicy(ROOT);
  const roles = loadRoles(ROOT);
  for (const n of ROLE_NAMES) if (!roles.has(n)) throw new Error(`нет файла роли .qwen/agents/${n}.md`);
  const dirty = (await changedPaths(ROOT)).filter((p) => !p.startsWith('.agentflow-runs/'));
  if (dirty.length) log.warn(`незакоммиченные изменения в основном репозитории не попадут в worktree: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? '…' : ''}`);

  const intent = readIntent(args.intent);
  const change = args.change ?? intent.change ?? 'change';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(change)) throw new Error(`id change "${change}" должен быть kebab-case`);
  const runStamp = stamp();
  const runId = `${runStamp}-${change}`;
  const runDir = join(ROOT, '.agentflow-runs', runId);
  mkdirSync(runDir, { recursive: true });
  const wt = join(runDir, 'worktree');
  const branchExists = (await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${policy.git.branchPrefix}${change}`], { cwd: ROOT })).code === 0;
  const branch = `${policy.git.branchPrefix}${change}${branchExists ? '-' + runStamp : ''}`;
  await addWorktree(ROOT, wt, branch);
  const baseCommit = await head(wt);

  const store = new RunStore(runDir);
  const os = new OpenSpec(ROOT, wt);
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
    baseCommit,
    options: { autoApprove: args.autoApprove, mock: args.mock, clarify: args.clarify, inject: args.inject },
    versions: { prompts: promptsRevision(ROOT), policy: policy.sha, sdk: sdkVersion(ROOT), openspec: await os.version() },
    stagesDone: [],
    intent: { source: intent.source, text: intent.text, clarifications: [] },
    spec: { order: [], artifacts: {}, holisticPassed: false, questions: [] },
    apply: { batches: [] },
    findings: [],
    gates: [],
    loops: [],
    models: {},
    usage: {},
    decisions: [],
    injected: [],
  };
  store.save();
  writeFileSync(join(runDir, 'intent.md'), intent.text + '\n');
  await os.newChange(change, policy.openspec.schema, intent.text.split('\n')[0]!.slice(0, 120));

  const ctx = makeCtx(ROOT, runDir, store, policy, roles);
  writeManifest(ctx);
  log.phase(`agentflow · run ${runId}`);
  log.info(`change ${c.bold(change)} · ветка ${branch} · worktree ${wt}`);
  log.info(`CLI: ${qwenExecutable(policy) ?? 'встроенный в SDK'} · SDK ${store.state.versions.sdk} · OpenSpec ${store.state.versions.openspec}${args.mock ? c.yellow(' · MOCK-роли') : ''}`);
  for (const n of ROLE_NAMES) {
    const r = roles.get(n)!;
    log.info(`  ${n.padEnd(18)} → ${r.model} · effort ${policy.qwen.effortViaSdk ? r.effort ?? 'по умолчанию' : 'по умолчанию (effortViaSdk: false)'} · ${r.file}`);
  }
  if (args.inject.length) log.inject(`включены точки: ${args.inject.join(', ')}`);
  await pipeline(ctx);
}

async function resumeRun(runId: string): Promise<void> {
  const runDir = join(ROOT, '.agentflow-runs', runId);
  const store = new RunStore(runDir);
  if (!store.exists()) throw new Error(`нет run ${runId}`);
  store.load();
  if (store.state.status === 'accepted') {
    console.log(`run ${runId} уже принят`);
    return;
  }
  const policy = loadPolicy(ROOT);
  const roles = loadRoles(ROOT);
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
  const runsDir = join(ROOT, '.agentflow-runs');
  const ids = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, 'state.json'))).sort() : [];
  if (!runId) {
    if (!ids.length) console.log('запусков нет');
    for (const id of ids) {
      const s = JSON.parse(readFileSync(join(runsDir, id, 'state.json'), 'utf8')) as RunState;
      console.log(`${id}  ${s.status.padEnd(9)} этап ${s.stage}${s.stopReason ? ` — ${s.stopReason.split('\n')[0]}` : ''}`);
    }
    return;
  }
  const s = JSON.parse(readFileSync(join(runsDir, runId, 'state.json'), 'utf8')) as RunState;
  console.log(`${s.runId}: ${s.status} · этап ${s.stage} · шаг ${s.step}${s.stopReason ? `\nпричина: ${s.stopReason}` : ''}`);
  console.log(`findings: open ${s.findings.filter((f) => f.status === 'open').length}, closed ${s.findings.filter((f) => f.status === 'closed').length}, logged ${s.findings.filter((f) => f.status === 'logged').length}`);
  printLoopSummary(s);
}

const USAGE = `agentflow — контроллер конвейера spec-driven разработки на Qwen Code

  npm run agentflow -- run <intent.md | "текст intent"> [опции]
      --change <id>      id change (по умолчанию из frontmatter или имени файла)
      --auto-approve     человеческие шлюзы отвечают сами (для прогонов без участия)
      --inject <точки>   fault injection: all или через запятую:
                           ${INJECT_HELP.join('\n                           ')}
      --mock             роли без моделей (проверка контроллера, петель, гейтов, git)
      --no-clarify       пропустить шаг уточнения intent
  npm run agentflow -- resume <run-id>
  npm run agentflow -- status [<run-id>]
  npm run agentflow -- agents [<run-id>]   список субагентов: роль, сессия, модель из ответа API
`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      change: { type: 'string' },
      'auto-approve': { type: 'boolean', default: false },
      inject: { type: 'string' },
      mock: { type: 'boolean', default: false },
      'no-clarify': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }
  if (cmd === 'run') {
    if (!arg) throw new Error('укажи intent: файл или текст');
    await startRun({ intent: arg, change: values.change, autoApprove: values['auto-approve'], mock: values.mock, clarify: !values['no-clarify'], inject: parseInject(values.inject) });
  } else if (cmd === 'resume') {
    if (!arg) throw new Error('укажи run-id (npm run agentflow -- status)');
    await resumeRun(arg);
  } else if (cmd === 'status') {
    showStatus(arg);
  } else if (cmd === 'agents') {
    const runsDir = join(ROOT, '.agentflow-runs');
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
