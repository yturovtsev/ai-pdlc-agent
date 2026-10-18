// Валидатор контракта ревью (.agentflow/review.schema.json) и правила принятия.
// Ревью — это контракт, а не мнение: переход разрешает контроллер по этому коду.
import { extractJson } from './util.ts';
import type { Severity } from './state.ts';

const STATUSES = ['PASS', 'REVISE', 'BLOCKED'] as const;
const RESULTS = ['PASS', 'FAIL', 'NOT_VERIFIED'] as const;
const SEVERITIES: Severity[] = ['critical', 'major', 'minor', 'nit'];

export type ReviewStatus = (typeof STATUSES)[number];
export type CheckResult = (typeof RESULTS)[number];

export interface ReviewFinding {
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
}

export interface Review {
  status: ReviewStatus;
  role: string;
  target: string;
  snapshotId: string;
  round: number;
  checks: { id: string; result: CheckResult; note?: string }[];
  specCompliance?: { result: CheckResult; summary: string } | null;
  codeQuality?: { result: CheckResult; summary: string } | null;
  findings: ReviewFinding[];
  traceability?: { requirementId: string; scenarioId?: string; code?: string[]; tests?: string[]; evidence?: string; result: CheckResult }[];
  missingContext?: string[];
}

export interface Expectation {
  role: string;
  target: string;
  snapshotId: string;
  round: number;
  /** Обязательные checks из рубрики. */
  mandatoryChecks: string[];
  /** code-reviewer: обязательны specCompliance и codeQuality. */
  needAssessments?: boolean;
  /** Финальное ревью: каждое requirementId должно быть в traceability. */
  requireTrace?: string[];
}

export type Validation =
  | { ok: true; review: Review; dropped: ReviewFinding[]; notes: string[] }
  | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export function validateReview(text: string, exp: Expectation): Validation {
  const raw = extractJson(text);
  if (!isObj(raw)) return { ok: false, error: 'ответ не содержит JSON-объекта' };
  const notes: string[] = [];

  if (!STATUSES.includes(raw['status'] as ReviewStatus)) return { ok: false, error: `status должен быть одним из ${STATUSES.join('/')}` };
  if (raw['role'] !== exp.role) return { ok: false, error: `role должен быть "${exp.role}"` };
  if (raw['target'] !== exp.target) return { ok: false, error: `target должен быть "${exp.target}"` };
  if (raw['snapshotId'] !== exp.snapshotId) return { ok: false, error: `snapshotId не совпадает с проверяемым (${exp.snapshotId}): вердикт к другой редакции` };
  if (raw['round'] !== exp.round) notes.push(`round ${String(raw['round'])} исправлен на ${exp.round}`);
  if (!Array.isArray(raw['checks'])) return { ok: false, error: 'checks должен быть массивом' };
  if (!Array.isArray(raw['findings'])) return { ok: false, error: 'findings должен быть массивом' };

  const checks: Review['checks'] = [];
  for (const ch of raw['checks']) {
    if (!isObj(ch) || !nonEmpty(ch['id']) || !RESULTS.includes(ch['result'] as CheckResult)) {
      return { ok: false, error: `некорректный check: ${JSON.stringify(ch)}` };
    }
    checks.push({ id: String(ch['id']), result: ch['result'] as CheckResult, note: ch['note'] ? String(ch['note']) : undefined });
  }
  const missing = exp.mandatoryChecks.filter((id) => !checks.some((ch) => ch.id === id));
  if (missing.length) return { ok: false, error: `нет обязательных checks: ${missing.join(', ')}` };

  const findings: ReviewFinding[] = [];
  const dropped: ReviewFinding[] = [];
  for (const f of raw['findings']) {
    if (!isObj(f) || !nonEmpty(f['id']) || !SEVERITIES.includes(f['severity'] as Severity) || !nonEmpty(f['problem'])) {
      return { ok: false, error: `некорректная находка: ${JSON.stringify(f).slice(0, 200)}` };
    }
    const finding = f as unknown as ReviewFinding;
    // Находка без evidence и location отбрасывается.
    if (!nonEmpty(f['evidence']) || !nonEmpty(f['location'])) dropped.push(finding);
    else findings.push(finding);
  }
  if (dropped.length) notes.push(`отброшено находок без evidence/location: ${dropped.length}`);

  let status = raw['status'] as ReviewStatus;
  const blocking = findings.filter((f) => f.severity === 'critical' || f.severity === 'major');
  // PASS при наличии critical или major — невалидный ответ.
  if (status === 'PASS' && blocking.length) return { ok: false, error: 'PASS при наличии critical/major находок' };
  // NOT_VERIFIED по обязательному check превращает ответ в BLOCKED, а не в PASS.
  const notVerified = checks.filter((ch) => exp.mandatoryChecks.includes(ch.id) && ch.result === 'NOT_VERIFIED');
  if (notVerified.length && status !== 'BLOCKED') {
    notes.push(`обязательные checks NOT_VERIFIED (${notVerified.map((ch) => ch.id).join(', ')}) → BLOCKED`);
    status = 'BLOCKED';
  }

  const assess = (key: 'specCompliance' | 'codeQuality') => {
    const v = raw[key];
    if (v === undefined || v === null) return null;
    if (!isObj(v) || !RESULTS.includes(v['result'] as CheckResult)) throw new Error(`${key} некорректен`);
    return { result: v['result'] as CheckResult, summary: String(v['summary'] ?? '') };
  };
  let specCompliance: Review['specCompliance'];
  let codeQuality: Review['codeQuality'];
  try {
    specCompliance = assess('specCompliance');
    codeQuality = assess('codeQuality');
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (exp.needAssessments && (!specCompliance || !codeQuality)) return { ok: false, error: 'code-reviewer обязан заполнить specCompliance и codeQuality' };

  const traceability = Array.isArray(raw['traceability']) ? (raw['traceability'] as Review['traceability']) : [];
  if (exp.requireTrace?.length) {
    const absent = exp.requireTrace.filter((id) => !traceability!.some((t) => t && t.requirementId === id));
    if (absent.length) return { ok: false, error: `traceability не покрывает требования: ${absent.join(', ')}` };
  }

  return {
    ok: true,
    dropped,
    notes,
    review: {
      status,
      role: exp.role,
      target: exp.target,
      snapshotId: exp.snapshotId,
      round: exp.round,
      checks,
      specCompliance,
      codeQuality,
      findings,
      traceability,
      missingContext: Array.isArray(raw['missingContext']) ? (raw['missingContext'] as string[]) : [],
    },
  };
}

export interface Decision {
  verdict: ReviewStatus;
  blocking: ReviewFinding[];
  logged: ReviewFinding[];
  human: ReviewFinding[];
  reason: string;
}

/**
 * Решение о переходе. critical и major блокируют переход, minor и nit пишутся в журнал.
 * needsHuman в фазе спеки копится в пакет вопросов, в apply переводит шаг в BLOCKED.
 */
export function decide(review: Review, phase: 'spec' | 'apply'): Decision {
  const human = review.findings.filter((f) => f.needsHuman);
  const blocking = review.findings.filter(
    (f) => (f.severity === 'critical' || f.severity === 'major') && !(phase === 'spec' && f.needsHuman),
  );
  const logged = review.findings.filter((f) => f.severity === 'minor' || f.severity === 'nit');
  if (review.status === 'BLOCKED') {
    const why = review.missingContext?.length ? `не хватает контекста: ${review.missingContext.join('; ')}` : 'ревьюер вернул BLOCKED';
    return { verdict: 'BLOCKED', blocking, logged, human, reason: why };
  }
  if (phase === 'apply' && human.length) {
    return { verdict: 'BLOCKED', blocking, logged, human, reason: `нужно решение человека в apply: ${human.map((f) => f.problem).join('; ')}` };
  }
  if (blocking.length) return { verdict: 'REVISE', blocking, logged, human, reason: `${blocking.length} блокирующих находок` };
  const reason = review.status === 'REVISE' ? 'REVISE без critical/major понижен до PASS' : 'блокирующих находок нет';
  return { verdict: 'PASS', blocking, logged, human, reason };
}

export function countBySeverity(findings: { severity: Severity }[]): string {
  return SEVERITIES.map((s) => `${s} ${findings.filter((f) => f.severity === s).length}`).join(' · ');
}

/** Пример ответа для промпта ревьюера. */
export function contractExample(exp: { role: string; target: string; snapshotId: string; round: number; code?: boolean; trace?: boolean }): string {
  const example = {
    status: 'REVISE',
    role: exp.role,
    target: exp.target,
    snapshotId: exp.snapshotId,
    round: exp.round,
    checks: [{ id: '<ID проверки из рубрики>', result: 'PASS', note: 'коротко, на чём основан результат' }],
    specCompliance: exp.code ? { result: 'PASS', summary: '...' } : null,
    codeQuality: exp.code ? { result: 'PASS', summary: '...' } : null,
    findings: [
      {
        id: 'F-001',
        severity: 'major',
        requirementId: 'REQ-...',
        artifact: null,
        category: 'spec',
        location: 'path/to/file.md:42',
        problem: 'что не так',
        evidence: 'цитата или path:line, подтверждающая проблему',
        requiredChange: 'что нужно изменить',
        verification: 'как проверить исправление',
        needsHuman: false,
      },
    ],
    traceability: exp.trace
      ? [{ requirementId: 'REQ-...', scenarioId: 'SCN-...', code: ['src/...'], tests: ['test/...', 'e2e/...'], evidence: 'e2e/evidence/...', result: 'PASS' }]
      : [],
    missingContext: [],
  };
  return [
    'Верни только JSON (можно в блоке ```json) ровно по контракту .agentflow/review.schema.json:',
    '```json',
    JSON.stringify(example, null, 2),
    '```',
    'status: PASS | REVISE | BLOCKED. checks[].result: PASS | FAIL | NOT_VERIFIED. severity: critical | major | minor | nit.',
    'critical и major блокируют переход, minor и nit только пишутся в журнал. PASS при critical/major — невалидный ответ.',
    'Находка без evidence или location отбрасывается. NOT_VERIFIED по обязательной проверке превращает ответ в BLOCKED.',
  ].join('\n');
}
