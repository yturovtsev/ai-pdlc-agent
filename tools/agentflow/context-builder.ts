// Пакеты контекста для ролей: каждая получает только то, что ей положено по контракту,
// и читает исходные файлы сама. Промпт сохраняется в contexts/ прогона для аудита.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Instructions } from './openspec.ts';
import { contractExample } from './review-validator.ts';
import type { Finding, Question } from './state.ts';
import { listFiles } from './util.ts';

export interface Rubric {
  name: string;
  path: string;
  text: string;
  mandatory: string[];
}

export function loadRubric(root: string, name: string): Rubric {
  const path = `.agentflow/rubrics/${name}.md`;
  const text = readFileSync(join(root, path), 'utf8');
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
  tasks: { id: string; text: string }[];
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
  clarifications: { question: string; answer: string }[];
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
    ? '\n\n### Уточнения пользователя\n' + ctx.clarifications.map((q) => `- В: ${q.question}\n  О: ${q.answer}`).join('\n')
    : '';
  return `## Intent пользователя\n\n${ctx.intent.trim()}${cl}`;
}

export function clarifyPrompt(ctx: BaseCtx): string {
  return [
    header('уточнение intent', ctx),
    '',
    'Ты spec-author на шаге уточнений. Этот шаг только на чтение: файлов не создавай.',
    'Прочитай intent и релевантный код (src/, test/, openspec/specs/). Сформулируй вопросы, без ответа на которые',
    'спеку пришлось бы писать на догадках. Не больше 5. Если всё однозначно — верни пустой список.',
    '',
    intentBlock(ctx),
    '',
    '## Формат ответа',
    '```json',
    '{"questions":[{"question":"...","why":"что зависит от ответа","options":["вариант 1","вариант 2"]}]}',
    '```',
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
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
    `{"artifact":"${a.id}","files":["${ctx.changeDir}/..."],"responses":[{"id":"F-001","resolution":"fixed","evidence":"что изменено"}],"questions":[{"question":"...","why":"...","options":["..."]}]}`,
    '```',
    'questions — только продуктовые развилки, которые нельзя решить из intent. Они не блокируют шаг:',
    'контроллер копит их и задаёт человеку пакетом при согласовании спеки.',
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
    '- код репозитория: src/, test/ — для проверки реализуемости',
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
    `- shell: только ${a.shell.map((s) => `./tools/agentflow/run.sh ${s}`).join(', ') || '(нет)'}`,
    '- git, установка пакетов и прочие команды недоступны; коммиты делает контроллер.',
    '',
    '## Definition of Done',
    '- каждая задача батча реализована, проверка из её описания выполнима;',
    '- unit-тест из сценария написан и проходит; run.sh lint и run.sh unit зелёные;',
    '- нет работы вне батча; спека, e2e/ и конфиги не тронуты.',
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
  a: { reqs: Requirement[]; specFiles: string[]; testPlan: string; snapshotId: string; rubric: Rubric },
): string {
  return [
    header('acceptance по замороженной спеке', ctx),
    '',
    `snapshotId (digest замороженной спеки): ${a.snapshotId}`,
    '',
    '## Манифест контекста',
    `- спека: ${a.specFiles.join(', ')}`,
    `- test-plan: ${a.testPlan}`,
    '- код читай только для диагностики (путь импорта, причина падения); проверки строй из спеки',
    '',
    '## Индекс сценариев — по одному check на каждый, id ровно такие',
    requirementsTable(a.reqs),
    '',
    '## Что сделать',
    '1. Напиши тесты в e2e/<capability>.test.js (node:test, node:assert/strict). В имени теста — id сценария.',
    '2. Запусти ./tools/agentflow/run.sh e2e (вывод сохранится в e2e/evidence/e2e-run.txt).',
    '3. Дополнительные доказательства сохрани в e2e/evidence/.',
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
    `- отчёт acceptance-tester: ${a.acceptancePath}`,
    '- e2e/ и e2e/evidence/ — acceptance-тесты и доказательства',
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
