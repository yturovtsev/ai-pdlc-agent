// Пакеты контекста для ролей: каждая получает только то, что ей положено по контракту,
// и читает исходные файлы сама. Промпт сохраняется в contexts/ прогона для аудита.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, layered } from './config.ts';
import type { ApplyTask, Instructions } from './openspec.ts';
import { contractExample } from './review-validator.ts';
import type { Clarification, DiscussTurn, Finding, Question, QuestionOption } from './state.ts';
import { extractJson, listFiles } from './util.ts';

export interface Rubric {
  name: string;
  path: string;
  text: string;
  mandatory: string[];
}

/**
 * Рубрика целевого репозитория (.agentflow/rubrics/<name>.md) или kit. Для артефакта схемы,
 * у которого своей рубрики нет (корпоративная схема), — общая рубрика artifact.md.
 */
export function loadRubric(repo: string, name: string): Rubric {
  let abs = layered(repo, `rubrics/${name}.md`, `.agentflow/rubrics/${name}.md`);
  if (!existsSync(abs)) abs = layered(repo, 'rubrics/artifact.md', '.agentflow/rubrics/artifact.md');
  const path = abs.startsWith(KIT + '/') ? `kit:${abs.slice(KIT.length + 1)}` : abs.slice(repo.length + 1);
  const text = readFileSync(abs, 'utf8');
  const section = text.split(/^## /m).find((s) => s.startsWith('Обязательные проверки')) ?? '';
  const mandatory = [...section.matchAll(/^- `([A-Z0-9-]+)`/gm)].map((m) => m[1]!);
  return { name, path, text, mandatory };
}

export interface Requirement {
  id: string;
  capability: string;
  name: string;
  file: string;
  scenarios: { id: string; name: string }[];
}

/** Индекс требований и сценариев из specs/ change: стабильные id для traceability. */
export function indexRequirements(changeDirAbs: string, changeDirRel: string): Requirement[] {
  const out: Requirement[] = [];
  for (const f of listFiles(join(changeDirAbs, 'specs')).filter((p) => p.endsWith('.md'))) {
    const capability = f.replace(/\/?spec\.md$/, '').replace(/\.md$/, '') || 'root';
    const cap = capability.toUpperCase().replace(/[^A-Z0-9]+/g, '-');
    const text = readFileSync(join(changeDirAbs, 'specs', f), 'utf8');
    let req: Requirement | undefined;
    for (const line of text.split('\n')) {
      const r = line.match(/^###\s+Requirement:\s*(.+)$/);
      const s = line.match(/^####\s+Scenario:\s*(.+)$/);
      if (r) {
        req = { id: `REQ-${cap}-${out.filter((x) => x.capability === capability).length + 1}`, capability, name: r[1]!.trim(), file: `${changeDirRel}/specs/${f}`, scenarios: [] };
        out.push(req);
      } else if (s && req) {
        req.scenarios.push({ id: `SCN-${req.id.slice(4)}.${req.scenarios.length + 1}`, name: s[1]!.trim() });
      }
    }
  }
  return out;
}

export function requirementsTable(reqs: Requirement[]): string {
  if (!reqs.length) return '(требований не найдено)';
  return reqs
    .map((r) => `- ${r.id} «${r.name}» (${r.file})\n` + r.scenarios.map((s) => `  - ${s.id} «${s.name}»`).join('\n'))
    .join('\n');
}

export interface TaskBatch {
  id: string;
  title: string;
  tasks: { id: string; text: string; done?: boolean; file?: string; line?: number }[];
}

/**
 * Батчи из задач, которые разобрал сам OpenSpec (формат файла задач — по схеме репозитория):
 * задачи под одним заголовком — один task batch; задачи без заголовка — батч «Задачи».
 */
export function batchesFromTasks(tasks: ApplyTask[]): TaskBatch[] {
  const batches: TaskBatch[] = [];
  const lines = new Map<string, string[]>();
  for (const t of tasks) {
    if (!lines.has(t.sourcePath)) lines.set(t.sourcePath, readFileSync(t.sourcePath, 'utf8').split('\n'));
    const src = lines.get(t.sourcePath)!;
    let title = 'Задачи';
    for (let i = t.line - 2; i >= 0; i--) {
      const h = src[i]!.match(/^#{2,6}\s+(.+)$/);
      if (h) {
        title = h[1]!.trim();
        break;
      }
    }
    const key = `${t.sourcePath}#${title}`;
    let b = batches.find((x) => (x as TaskBatch & { key?: string }).key === key);
    if (!b) {
      const num = title.match(/^(\d+)[.)]/)?.[1];
      b = Object.assign({ id: num ?? String(batches.length + 1), title: title.replace(/^\d+[.)]\s*/, ''), tasks: [] }, { key });
      batches.push(b);
    }
    const tid = t.description.match(/^(\d+(?:\.\d+)+)\s+/)?.[1] ?? `${b.id}.${b.tasks.length + 1}`;
    b.tasks.push({ id: tid, text: t.description.replace(/^\d+(?:\.\d+)+\s+/, ''), done: t.done, file: t.sourcePath, line: t.line });
  }
  return batches.map(({ id, title, tasks: ts }) => ({ id, title, tasks: ts }));
}

/** Группа "## N. Название" = один task batch; задачи "- [ ] N.M описание". */
export function parseTasks(text: string): TaskBatch[] {
  const batches: TaskBatch[] = [];
  let cur: TaskBatch | undefined;
  for (const line of text.split('\n')) {
    const g = line.match(/^##\s+(\d+)\.\s*(.+)$/);
    const t = line.match(/^\s*- \[[ xX]?\]\s+(\d+\.\d+)\s+(.+)$/);
    if (g) {
      cur = { id: g[1]!, title: g[2]!.trim(), tasks: [] };
      batches.push(cur);
    } else if (t && cur) {
      cur.tasks.push({ id: t[1]!, text: t[2]!.trim() });
    }
  }
  return batches.filter((b) => b.tasks.length > 0);
}

export function formatFindings(findings: Finding[]): string {
  if (!findings.length) return '(нет)';
  return findings
    .map((f) => {
      const lines = [`- ${f.id} [${f.severity}] ${f.location} — ${f.problem}`];
      if (f.requirementId) lines.push(`  требование: ${f.requirementId}`);
      lines.push(`  evidence: ${f.evidence}`);
      if (f.requiredChange) lines.push(`  требуется: ${f.requiredChange}`);
      if (f.verification) lines.push(`  проверка: ${f.verification}`);
      if (f.response) lines.push(`  ответ автора: ${f.response.resolution} — ${f.response.evidence}`);
      if (f.waiver) lines.push(`  СНЯТО ЧЕЛОВЕКОМ (waiver): ${f.waiver.reason} — не поднимай повторно без новых оснований`);
      lines.push(`  источник: ${f.source}, раунд ${f.round}`);
      return lines.join('\n');
    })
    .join('\n');
}

export function writeContext(contextsDir: string, label: string, prompt: string): string {
  const file = join(contextsDir, `${label.replace(/[^\w.-]+/g, '_')}.md`);
  writeFileSync(file, prompt);
  return file;
}

export interface BaseCtx {
  change: string;
  /** openspec/changes/<change> относительно worktree. */
  changeDir: string;
  intent: string;
  clarifications: Clarification[];
}

function header(step: string, ctx: BaseCtx): string {
  return [
    `# Задача контроллера agentflow · ${step}`,
    '',
    `Change: ${ctx.change}. Рабочий каталог — git worktree этого change; все пути ниже относительно него.`,
    'Решение о переходе принимает контроллер по твоему ответу и детерминированным проверкам.',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function intentBlock(ctx: BaseCtx): string {
  const cl = ctx.clarifications.length
    ? '\n\n### Уточнения пользователя\n' +
      ctx.clarifications.map((q) => `- В: ${q.question}\n  О: ${q.answer}${q.discussion?.length ? '\n' + formatDiscussion(q.discussion, '  ') : ''}`).join('\n')
    : '';
  return `## Intent пользователя\n\n${ctx.intent.trim()}${cl}`;
}

const QUESTION_ITEM =
  '[{"question":"...","why":"что зависит от ответа","options":[{"label":"вариант 1","description":"последствия"},{"label":"вариант 2","description":"последствия"}],"recommended":0,"rationale":"почему рекомендуешь этот вариант"}]';
const QUESTION_EXAMPLE = `{"questions":${QUESTION_ITEM}}`;
const QUESTION_RULES =
  'Человек выбирает ответ стрелками из options: дай 2-4 взаимоисключающих варианта с коротким label, ' +
  'в recommended — индекс рекомендуемого, в rationale — одно предложение, почему именно он.';

export function clarifyPrompt(ctx: BaseCtx): string {
  return [
    header('уточнение intent', ctx),
    '',
    'Ты spec-author на шаге уточнений. Этот шаг только на чтение: файлов не создавай.',
    'Прочитай intent, релевантный код репозитория и openspec/specs/. Сформулируй вопросы, без ответа на которые',
    'спеку пришлось бы писать на догадках. Не больше 5. Если всё однозначно — верни пустой список.',
    '',
    intentBlock(ctx),
    '',
    '## Формат ответа',
    '```json',
    QUESTION_EXAMPLE,
    '```',
    QUESTION_RULES,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Ответ роли в обсуждении длиннее этого обрезается в уточнениях и находках: полный — в contexts/ и events.jsonl. */
const DISCUSS_ANSWER_CAP = 1500;

/** Переписка обсуждения вопроса для промптов следующих ролей и находки человека. */
export function formatDiscussion(turns: DiscussTurn[], indent = '', cap = DISCUSS_ANSWER_CAP): string {
  const cut = (t: string) => (t.length > cap ? t.slice(0, cap) + ' …' : t);
  return [`${indent}Обсуждение (${turns.length}):`, ...turns.map((t) => `${indent}- Человек: ${t.message}\n${indent}  ${t.role ?? 'Роль'}: ${cut(t.answer)}`)].join('\n');
}

export interface DecisionDiscussInput {
  /** Гейт решения: exhausted:batch 2, blocked:final. */
  gate: string;
  role: string;
  title: string;
  /** Строки над меню: находки, причина вердикта. */
  context: string[];
  options: { label: string; description?: string; disabled?: string }[];
  recommended: string;
  rationale: string;
  /** Файлы петли: артефакт, diff батча или финала, отчёт acceptance (относительно worktree или абсолютные). */
  files: string[];
  history: DiscussTurn[];
  message: string;
}

/** Реплика обсуждения решения человека: роль объясняет, но не выбирает и ничего не меняет. */
export function decisionDiscussPrompt(ctx: BaseCtx, d: DecisionDiscussInput): string {
  return [
    header(`обсуждение решения ${d.gate}`, ctx),
    '',
    `Человек решает, что делать с петлёй конвейера, и хочет обсудить это с тобой (${d.role}), прежде чем выбрать.`,
    'Этот шаг только на чтение: файлов не создавай и не меняй. Читать код, спеки, артефакты и diff можно.',
    '',
    intentBlock(ctx),
    '',
    `## Решение: ${d.title}`,
    '',
    d.context.length ? d.context.map((l) => `- ${l}`).join('\n') : '(без контекста)',
    '',
    '### Варианты',
    d.options.map((o) => `- ${o.label}${o.description ? ` — ${o.description}` : ''}${o.disabled ? ` (недоступен: ${o.disabled})` : ''}${o.label === d.recommended ? ' (рекомендует контроллер)' : ''}`).join('\n'),
    `\nПочему контроллер рекомендует «${d.recommended}»: ${d.rationale}`,
    d.files.length ? `\n## Файлы петли (прочитай сами)\n${d.files.map((f) => `- ${f}`).join('\n')}` : '',
    '',
    '## Обсуждение до сих пор',
    d.history.length ? d.history.map((t, i) => `### Реплика ${i + 1}\nЧеловек: ${t.message}\n\n${t.role === d.role ? 'Ты' : (t.role ?? 'Роль')}: ${t.answer}`).join('\n\n') : '(это первая реплика)',
    '',
    '## Новая реплика человека',
    '',
    d.message,
    '',
    '## Как отвечать',
    'Ответь по существу: насколько серьёзны находки, что даст каждый вариант, ссылки на файлы (путь:строка), если помогают.',
    'Не выбирай за человека и не меняй варианты. Ответ — текстом или одним JSON-блоком `{"answer":"ответ человеку"}`.',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Ответ реплики обсуждения решения: только текст, варианты решения роль не меняет. */
export function parseDecisionReply(text: string): { answer: string } | { error: string } {
  const r = parseDiscussReply(text);
  return 'error' in r ? r : { answer: r.answer };
}

export interface DiscussInput {
  id: string;
  question: string;
  why?: string;
  options: QuestionOption[];
  recommended: number;
  rationale?: string;
  /** Файлы артефакта, к которому относится вопрос (относительно worktree). */
  files: string[];
  history: DiscussTurn[];
  message: string;
}

export function discussPrompt(ctx: BaseCtx, d: DiscussInput): string {
  return [
    header(`обсуждение вопроса ${d.id}`, ctx),
    '',
    'Ты задал человеку вопрос с вариантами ответа. Прежде чем выбрать, человек хочет его обсудить.',
    'Этот шаг только на чтение: файлов не создавай и не меняй. Читать код, спеки и артефакты можно.',
    '',
    intentBlock(ctx),
    '',
    '## Вопрос',
    '',
    d.question,
    d.why ? `\nОт ответа зависит: ${d.why}` : '',
    '',
    '### Варианты',
    d.options.map((o, i) => `${i}. ${o.label}${o.description ? ` — ${o.description}` : ''}${i === d.recommended ? ' (рекомендуешь)' : ''}`).join('\n'),
    d.rationale ? `\nПочему рекомендуешь: ${d.rationale}` : '',
    d.files.length ? `\n## Артефакт вопроса (прочитай сами файлы)\n${d.files.map((f) => `- ${f}`).join('\n')}` : '',
    '',
    '## Обсуждение до сих пор',
    d.history.length ? d.history.map((t, i) => `### Реплика ${i + 1}\nЧеловек: ${t.message}\n\nТы: ${t.answer}`).join('\n\n') : '(это первая реплика)',
    '',
    '## Новая реплика человека',
    '',
    d.message,
    '',
    '## Как отвечать',
    'Ответь на реплику по существу: последствия вариантов, отличия, ссылки на файлы (путь:строка), если они помогают.',
    'Не выбирай за человека. Меняй варианты, только если обсуждение показало, что они неполны или неточны:',
    'тогда верни весь новый список (2-6 вариантов), индекс рекомендуемого и обоснование. Иначе options не возвращай.',
    '',
    '## Формат ответа',
    'Закончи ответ одним JSON-блоком:',
    '```json',
    '{"answer":"ответ человеку","options":[{"label":"вариант","description":"последствия"}],"recommended":0,"rationale":"почему этот вариант"}',
    '```',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Разобранный ответ реплики: варианты — только если роль их заменила и они допустимы. */
export interface DiscussReply {
  answer: string;
  options?: QuestionOption[];
  recommended?: number;
  rationale?: string;
}

/**
 * Ответ роли в обсуждении. Разговор, а не гейт: без JSON ответом считается весь текст.
 * Недопустимые варианты отбрасываются молча — остаются прежние.
 */
export function parseDiscussReply(text: string): DiscussReply | { error: string } {
  const j = extractJson(text) as Record<string, unknown> | undefined;
  // JSON без answer: ответом считается текст вне JSON-блоков; без JSON — весь текст без обрамления кода.
  const fromJson = typeof j?.['answer'] === 'string' ? j['answer'].trim() : '';
  const answer = fromJson || (j ? text.replace(/```[\s\S]*?```/g, '') : text.replace(/```[\w-]*\n?|```/g, '')).trim();
  if (!answer) return { error: 'роль вернула пустой ответ' };
  const raw = Array.isArray(j?.['options']) ? (j!['options'] as unknown[]) : undefined;
  const options = raw
    ?.map((o) =>
      typeof o === 'string'
        ? { label: o.trim() }
        : { label: String((o as Record<string, unknown>)?.['label'] ?? '').trim(), description: (o as Record<string, unknown>)?.['description'] as string | undefined },
    )
    .map((o) => (o.description ? o : { label: o.label }));
  if (!options || options.length < 2 || options.length > 6 || options.some((o) => !o.label)) return { answer };
  const rec = Number(j!['recommended']);
  const recommended = Number.isInteger(rec) && rec >= 0 && rec < options.length ? rec : 0;
  const rationale = typeof j!['rationale'] === 'string' ? j!['rationale'] : undefined;
  return { answer, options, recommended, ...(rationale ? { rationale } : {}) };
}

export function authorPrompt(
  ctx: BaseCtx,
  a: {
    id: string;
    generates: string;
    round: number;
    max: number;
    instructions: Instructions;
    upstream: { id: string; files: string[] }[];
    rubric: Rubric;
    findings: Finding[];
    exists: boolean;
    /** Артефакт — файл задач apply (apply.requires схемы). */
    tracked?: boolean;
  },
): string {
  const ins = a.instructions;
  const extra = [ins.context ? `### Контекст проекта\n${String(ins.context)}` : '', ins.rules ? `### Правила проекта\n${JSON.stringify(ins.rules, null, 2)}` : '']
    .filter(Boolean)
    .join('\n\n');
  return [
    header(`генерация артефакта «${a.id}» · раунд ${a.round}/${a.max}`, ctx),
    '',
    `Пиши только артефакт «${a.id}»: ${ctx.changeDir}/${a.generates}. Остальные файлы не трогай — запись будет отклонена.`,
    a.exists ? 'Артефакт уже существует: исправь его по находкам ниже, не переписывая то, что к ним не относится.' : '',
    a.tracked
      ? 'Это файл задач фазы apply. Каждый раздел с заголовком `##` станет одним task batch (1-4 задачи) — один вызов implementer и одно ревью кода. Acceptance-тесты не планируй: их пишет отдельная роль. Галочки не ставь: прогресс отмечает контроллер.'
      : '',
    '',
    intentBlock(ctx),
    '',
    '## Инструкция OpenSpec для артефакта',
    '',
    ins.instruction ?? '(нет)',
    '',
    '### Шаблон',
    '```markdown',
    ins.template ?? '',
    '```',
    extra,
    '',
    '## Принятые upstream-артефакты (прочитай сами файлы)',
    a.upstream.length ? a.upstream.map((u) => `- ${u.id}: ${u.files.map((f) => `${ctx.changeDir}/${f}`).join(', ')}`).join('\n') : '(нет)',
    '',
    `## Рубрика ревью (${a.rubric.path})`,
    '',
    a.rubric.text,
    '',
    '## Находки к исправлению',
    '',
    formatFindings(a.findings),
    a.findings.length ? '\nПо каждой находке ответь fixed (что изменено) или disputed (доказательство: цитата или путь:строка).' : '',
    '',
    '## Формат ответа',
    'Закончи ответ одним JSON-блоком:',
    '```json',
    `{"artifact":"${a.id}","files":["${ctx.changeDir}/..."],"responses":[{"id":"F-001","resolution":"fixed","evidence":"что изменено"}],"questions":${QUESTION_ITEM}}`,
    '```',
    'questions — только продуктовые развилки, которые нельзя решить из intent. Они не блокируют шаг:',
    'в артефакте прими рекомендуемый вариант как допущение, а человек ответит на твоём ревью артефакта.',
    QUESTION_RULES,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function specReviewPrompt(
  ctx: BaseCtx,
  a: {
    id: string;
    files: string[];
    upstream: { id: string; files: string[] }[];
    rubric: Rubric;
    snapshotId: string;
    round: number;
    max: number;
    prior: Finding[];
    fixDiffPath?: string;
    instructionsPath: string;
  },
): string {
  return [
    header(`ревью артефакта «${a.id}» · раунд ${a.round}/${a.max}`, ctx),
    '',
    `snapshotId проверяемой редакции: ${a.snapshotId}`,
    '',
    '## Манифест контекста (файлы читай сам)',
    `- артефакт: ${a.files.map((f) => `${ctx.changeDir}/${f}`).join(', ') || '(файлов нет)'}`,
    `- upstream: ${a.upstream.flatMap((u) => u.files.map((f) => `${ctx.changeDir}/${f}`)).join(', ') || '(нет)'}`,
    `- инструкция OpenSpec для этого артефакта: ${a.instructionsPath}`,
    '- код репозитория — для проверки реализуемости',
    a.fixDiffPath ? `- diff исправлений с прошлого раунда: ${a.fixDiffPath}` : '',
    '',
    intentBlock(ctx),
    '',
    `## Рубрика (${a.rubric.path})`,
    '',
    a.rubric.text,
    '',
    `Обязательные checks: ${a.rubric.mandatory.join(', ')}. Каждый — в checks[] с id ровно как здесь.`,
    '',
    '## Находки прошлого раунда и ответы автора',
    '',
    formatFindings(a.prior),
    a.prior.length ? '\nИсправленные не повторяй — так они закрываются. Неисправленные повтори с тем же id.' : '',
    '',
    '## Контракт ответа',
    '',
    contractExample({ role: 'spec-reviewer', target: a.id, snapshotId: a.snapshotId, round: a.round }),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function holisticPrompt(
  ctx: BaseCtx,
  a: { artifacts: { id: string; files: string[] }[]; reqs: Requirement[]; rubric: Rubric; snapshotId: string; round: number; max: number; prior: Finding[] },
): string {
  return [
    header(`сквозное ревью спеки · раунд ${a.round}/${a.max}`, ctx),
    '',
    'Ты свежий spec-reviewer: каждый артефакт уже прошёл своё ревью. Теперь проверь пакет целиком.',
    `snapshotId (digest всего пакета): ${a.snapshotId}`,
    '',
    '## Манифест контекста',
    a.artifacts.map((x) => `- ${x.id}: ${x.files.map((f) => `${ctx.changeDir}/${f}`).join(', ')}`).join('\n'),
    '',
    '## Индекс требований (id для requirementId)',
    requirementsTable(a.reqs),
    '',
    intentBlock(ctx),
    '',
    `## Рубрика (${a.rubric.path})`,
    a.rubric.text,
    `Обязательные checks: ${a.rubric.mandatory.join(', ')}.`,
    'В каждой блокирующей находке поле artifact = id артефакта, который нужно исправить: ' + a.artifacts.map((x) => x.id).join(', ') + '.',
    '',
    '## Находки прошлого раунда',
    formatFindings(a.prior),
    '',
    '## Контракт ответа',
    contractExample({ role: 'spec-reviewer', target: 'change', snapshotId: a.snapshotId, round: a.round }),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function implementerPrompt(
  ctx: BaseCtx,
  a: {
    batch: TaskBatch;
    round: number;
    max: number;
    reqs: Requirement[];
    specFiles: string[];
    write: string[];
    denyWrite: string[];
    shell: string[];
    findings: Finding[];
    failures: string[];
    gateOutput?: string;
    fresh: boolean;
  },
): string {
  return [
    header(`реализация task batch ${a.batch.id} «${a.batch.title}» · раунд ${a.round}/${a.max}`, ctx),
    '',
    a.fresh ? '' : 'Это продолжение твоей сессии по этому батчу.',
    a.failures.length
      ? '## Сводка прошлых неудачных раундов (условия изменены: новая сессия со свежим контекстом)\n' + a.failures.map((f) => `- ${f}`).join('\n')
      : '',
    '',
    '## Задачи батча',
    a.batch.tasks.map((t) => `- ${t.id} ${t.text}`).join('\n'),
    '',
    '## Спека заморожена (прочитай сам; не меняй)',
    a.specFiles.map((f) => `- ${f}`).join('\n'),
    '',
    '## Требования и сценарии',
    requirementsTable(a.reqs),
    '',
    '## Разрешено',
    `- писать: ${a.write.join(', ')}`,
    `- нельзя писать: ${a.denyWrite.join(', ') || '(нет)'}`,
    `- shell: только ${a.shell.map((s) => `agentflow-gate ${s}`).join(', ') || '(нет)'}`,
    '- git, установка пакетов и прочие команды недоступны; коммиты делает контроллер.',
    '',
    '## Definition of Done',
    '- каждая задача батча реализована, проверка из её описания выполнима;',
    `- unit-тест из сценария написан и проходит; ${a.shell.map((s) => `agentflow-gate ${s}`).join(' и ') || 'гейты'} зелёные;`,
    '- нет работы вне батча; спека, acceptance-тесты и конфиги не тронуты.',
    '',
    a.gateOutput ? '## Красные гейты — исправь\n' + a.gateOutput : '',
    a.findings.length ? '## Находки ревью к исправлению\n' + formatFindings(a.findings) + '\nПо каждой ответь fixed или disputed с доказательством.' : '',
    '',
    '## Формат ответа',
    '```json',
    '{"status":"DONE","tasks":[{"id":"1.1","done":true,"verification":"как проверено"}],"responses":[{"id":"F-001","resolution":"fixed","evidence":"..."}],"specIssue":null}',
    '```',
    'status: DONE | NEEDS_SPEC_CHANGE (спека противоречива или неисполнима — опиши в specIssue, код не пиши).',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function codeReviewPrompt(
  ctx: BaseCtx,
  a: {
    batch: TaskBatch;
    round: number;
    max: number;
    reqs: Requirement[];
    specFiles: string[];
    diffPath: string;
    fixDiffPath?: string;
    base: string;
    head: string;
    gates: string;
    rubric: Rubric;
    snapshotId: string;
    prior: Finding[];
  },
): string {
  return [
    header(`ревью task batch ${a.batch.id} · раунд ${a.round}/${a.max}`, ctx),
    '',
    `snapshotId: ${a.snapshotId} (base ${a.base.slice(0, 10)}, head ${a.head.slice(0, 10)})`,
    '',
    '## Task brief',
    a.batch.tasks.map((t) => `- ${t.id} ${t.text}`).join('\n'),
    '',
    '## Манифест контекста',
    `- полный diff батча: ${a.diffPath}`,
    a.fixDiffPath ? `- diff исправлений с прошлого раунда: ${a.fixDiffPath}` : '',
    `- спека: ${a.specFiles.join(', ')}`,
    '- вызывающий и соседний код читай при необходимости',
    '',
    '## Требования и сценарии',
    requirementsTable(a.reqs),
    '',
    '## Результаты гейтов (запускал контроллер)',
    a.gates,
    '',
    `## Рубрика (${a.rubric.path})`,
    a.rubric.text,
    `Обязательные checks: ${a.rubric.mandatory.join(', ')}.`,
    '',
    '## Находки прошлого раунда и ответы implementer',
    formatFindings(a.prior),
    '',
    '## Контракт ответа',
    contractExample({ role: 'code-reviewer', target: `batch-${a.batch.id}`, snapshotId: a.snapshotId, round: a.round, code: true }),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function acceptancePrompt(
  ctx: BaseCtx,
  a: { reqs: Requirement[]; specFiles: string[]; testPlan?: string; snapshotId: string; rubric: Rubric; dir: string; framework: string; shell: string[] },
): string {
  return [
    header('acceptance по замороженной спеке', ctx),
    '',
    `snapshotId (digest замороженной спеки): ${a.snapshotId}`,
    '',
    '## Манифест контекста',
    `- спека: ${a.specFiles.join(', ')}`,
    a.testPlan ? `- test-plan: ${a.testPlan}` : '- отдельного test-plan в схеме нет: проверки строй из сценариев спеки',
    '- код читай только для диагностики (путь импорта, причина падения); проверки строй из спеки',
    '',
    '## Индекс сценариев — по одному check на каждый, id ровно такие',
    requirementsTable(a.reqs),
    '',
    '## Что сделать',
    `1. Напиши тесты в ${a.dir}/: ${a.framework}. В имени теста — id сценария.`,
    `2. Запусти ${a.shell.map((s) => `agentflow-gate ${s}`).join(', ') || 'тесты'} — других shell-команд нет.`,
    `3. Вывод прогона и прочие доказательства сохрани в ${a.dir}/evidence/.`,
    '',
    `## Рубрика (${a.rubric.path})`,
    a.rubric.text,
    '',
    '## Контракт ответа',
    contractExample({ role: 'acceptance-tester', target: 'acceptance', snapshotId: a.snapshotId, round: 1, trace: true }),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function finalReviewPrompt(
  ctx: BaseCtx,
  a: {
    round: number;
    max: number;
    reqs: Requirement[];
    specFiles: string[];
    diffPath: string;
    base: string;
    head: string;
    gates: string;
    acceptancePath: string;
    acceptanceDir: string;
    /** acceptance-tester выключен в настройках run: отчёта и тестов нет. */
    acceptanceOff?: boolean;
    rubric: Rubric;
    snapshotId: string;
    prior: Finding[];
  },
): string {
  return [
    header(`финальное ревью change · раунд ${a.round}/${a.max}`, ctx),
    '',
    `snapshotId: ${a.snapshotId} (base ${a.base.slice(0, 10)}, head ${a.head.slice(0, 10)})`,
    '',
    '## Манифест контекста',
    `- полный diff фазы apply: ${a.diffPath}`,
    `- спека: ${a.specFiles.join(', ')}`,
    ...(a.acceptanceOff
      ? ['- acceptance-tester выключен в настройках run: отчёта acceptance нет, сценарии сверяй по коду и unit-тестам']
      : [`- отчёт acceptance-tester: ${a.acceptancePath}`, `- ${a.acceptanceDir}/ и ${a.acceptanceDir}/evidence/ — acceptance-тесты и доказательства`]),
    '',
    '## Индекс требований — каждое requirementId обязано быть в traceability[]',
    requirementsTable(a.reqs),
    '',
    '## Полные гейты (запускал контроллер)',
    a.gates,
    '',
    `## Рубрика (${a.rubric.path})`,
    a.rubric.text,
    `Обязательные checks: ${a.rubric.mandatory.join(', ')}.`,
    '',
    '## Находки прошлого раунда',
    formatFindings(a.prior),
    '',
    '## Контракт ответа',
    contractExample({ role: 'code-reviewer', target: 'final', snapshotId: a.snapshotId, round: a.round, code: true, trace: true }),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function questionsBlock(questions: Question[]): string {
  return questions.map((q) => `- ${q.id} (${q.artifact}): ${q.question}${q.answer ? `\n  ответ: ${q.answer}` : ''}`).join('\n');
}
