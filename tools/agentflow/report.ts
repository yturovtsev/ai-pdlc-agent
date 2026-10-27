// ACCEPTANCE.md — отчёт для человеческой приёмки и сводка пройденных петель.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { c } from './log.ts';
import type { RunState } from './state.ts';
import { skippedSteps, specOnly } from './run-settings.ts';
import { short } from './util.ts';

export function loopSummary(s: RunState): { loop: string; rounds: number; path: string }[] {
  const by = new Map<string, string[]>();
  for (const l of s.loops) by.set(l.loop, [...(by.get(l.loop) ?? []), l.verdict]);
  return [...by.entries()].map(([loop, verdicts]) => ({ loop, rounds: verdicts.length, path: verdicts.join(' → ') }));
}

export function printLoopSummary(s: RunState): void {
  const rows = loopSummary(s);
  console.log('\n' + c.bold('Пройденные петли'));
  for (const r of rows) {
    const colored = r.path.replace(/PASS/g, c.green('PASS')).replace(/REVISE|RED/g, (m) => c.yellow(m)).replace(/BLOCKED/g, c.red('BLOCKED'));
    console.log(`  ${r.loop.padEnd(28)} ${String(r.rounds).padStart(2)} раунд(ов)  ${colored}`);
  }
}

/** Раздел «Режим прогона» — только для run режима --auto-until-review. */
function modeSection(s: RunState): string[] {
  if (!s.options?.untilReview) return [];
  const h = s.handover;
  const auto = h ? s.decisions.filter((d) => d.at <= h.at).length : s.decisions.length;
  const blocking = s.findings.filter((f) => (f.severity === 'critical' || f.severity === 'major') && (f.status === 'open' || f.status === 'fixed' || f.status === 'disputed'));
  return [
    '## Режим прогона',
    '',
    '- режим: `--auto-until-review` — решения до приёмки принимает автопилот, waiver и переход дальше он не выбирает',
    `- решений автопилота: ${auto}`,
    `- решения переданы человеку: ${h ? `${h.at} — ${h.reason}` : 'нет, автопилот ещё ведёт run'}`,
    `- открытых находок critical и major: ${blocking.length}${blocking.length ? ` (${blocking.map((f) => f.id).join(', ')})` : ''}`,
    `- waiver: ${s.findings.filter((f) => f.status === 'waived').length} · переходов дальше: ${(s.proceeded ?? []).length}`,
    '',
  ];
}

export function writeAcceptanceReport(runDir: string, s: RunState, manualCheck: string): string {
  const path = join(runDir, 'ACCEPTANCE.md');
  const specRun = specOnly(s.options?.skip ?? []);
  const trace = (s.final?.traceability ?? []) as { requirementId: string; scenarioId?: string; code?: string[]; tests?: string[]; evidence?: string; result: string }[];
  const acc = s.acceptance?.report as { checks?: { id: string; result: string; note?: string }[] } | undefined;
  const logged = s.findings.filter((f) => f.status === 'logged');
  const open = s.findings.filter((f) => f.status === 'open');
  const waived = s.findings.filter((f) => f.status === 'waived');
  const usage = Object.entries(s.usage);
  const md = [
    `# Приёмка: ${s.change}`,
    '',
    `Статус конвейера: **${s.status === 'running' ? 'готово к приёмке' : s.status === 'awaiting-review' ? 'ждёт ревью человека' : s.status.toUpperCase()}**${s.stopReason ? ` — ${s.stopReason}` : ''}.`,
    '',
    `- run: \`${s.runId}\``,
    `- ветка: \`${s.branch}\`, worktree: \`${s.worktree}\``,
    `- база: \`${s.baseCommit.slice(0, 10)}\`, digest спеки: \`${s.spec.freeze ? short(s.spec.freeze.digest) : 'не заморожена'}\``,
    '',
    '## Настройки прогона',
    '',
    `- выключены роли: ${s.options?.skip?.length ? s.options.skip.join(', ') : 'нет'}`,
    ...skippedSteps(s.options?.skip ?? []).map((x) => `- пропущено — ${x}`),
    `- уточнение intent: ${s.options?.clarify === false ? 'нет' : 'да'} · автопилот: ${s.options?.autoApprove ? 'да' : s.options?.untilReview ? 'до приёмки (--auto-until-review)' : 'нет'}`,
    '',
    ...modeSection(s),
    '## Пройденные петли',
    '',
    '| Петля | Раундов | Вердикты |',
    '| --- | --- | --- |',
    ...loopSummary(s).map((r) => `| ${r.loop} | ${r.rounds} | ${r.path} |`),
    '',
    '## Пройдено решением человека',
    '',
    (s.proceeded ?? []).length
      ? s.proceeded.map((p) => `- ${p.at} · ${p.loop}: ${p.label} — причина: ${p.reason}${p.findings.length ? ` · сняты находки: ${p.findings.join(', ')}` : ''}`).join('\n')
      : '(нет)',
    '',
    '## Трассировка требований (финальное ревью)',
    '',
    specRun
      ? '(implementer выключен — run только со спекой, кода и трассировки нет)'
      : trace.length
        ? '| Требование | Сценарий | Код | Тесты | Evidence | Итог |\n| --- | --- | --- | --- | --- | --- |'
        : s.final?.status === 'PASSED_BY_HUMAN'
          ? '(финальное ревью пройдено решением человека — трассировки нет)'
          : s.final?.status === 'GATES_ONLY'
            ? '(ревью кода выключено в настройках run — финал по полным гейтам, трассировки нет)'
            : '(финальное ревью не пройдено)',
    ...trace.map((t) => `| ${t.requirementId} | ${t.scenarioId ?? ''} | ${(t.code ?? []).join(', ')} | ${(t.tests ?? []).join(', ')} | ${t.evidence ?? ''} | ${t.result} |`),
    '',
    '## Acceptance-сценарии',
    '',
    acc?.checks?.length ? acc.checks.map((ch) => `- ${ch.id}: ${ch.result}${ch.note ? ` — ${ch.note}` : ''}`).join('\n') : '(не запускались)',
    '',
    '## Гейты',
    '',
    s.gates.length ? s.gates.slice(-12).map((g) => `- ${g.step} · ${g.op}: ${g.ok ? 'зелёный' : 'красный'} (${g.logPath})`).join('\n') : '(не запускались)',
    '',
    '## Открытые находки',
    '',
    open.length ? open.map((f) => `- ${f.id} [${f.severity}] ${f.step}: ${f.problem} (${f.location})`).join('\n') : '(нет)',
    '',
    '## Снятые находки (waiver)',
    '',
    waived.length ? waived.map((f) => `- ${f.id} [${f.severity}] ${f.step}: ${f.problem} — причина: ${f.waiver?.reason} (${f.waiver?.at}, snapshot ${short(f.waiver?.snapshot ?? '')})`).join('\n') : '(нет)',
    '',
    '## Журнал minor и nit',
    '',
    logged.length ? logged.map((f) => `- ${f.id} [${f.severity}] ${f.step}: ${f.problem} (${f.location})`).join('\n') : '(нет)',
    '',
    '## Модели и расход',
    '',
    ...Object.entries(s.models).map(([role, m]) => `- ${role}: запрошена \`${m.requested}\` (effort ${m.effort ?? 'по умолчанию'}), из ответа API: ${m.actual.join(', ') || 'не сообщена'}`),
    ...usage.map(([role, u]) => `- ${role}: вызовов ${u.calls}, ходов ${u.turns}, токенов ${u.inputTokens}/${u.outputTokens}, ${u.seconds} с`),
    '',
    '## Решения человека',
    '',
    s.decisions.length ? s.decisions.map((d) => `- ${d.at} · ${d.gate}: ${d.decision}${d.comment ? ` — ${d.comment}` : ''}`).join('\n') : '(нет)',
    '',
    '## Ручная проверка',
    '',
    manualCheck || (specRun ? `прочитай спеку: ${s.worktree}/openspec/changes/${s.change}; код — agentflow run --change ${s.change} после merge ветки` : `cd ${s.worktree} && npm --prefix ${s.repoRoot} run lint`),
    '',
    '## Дальше (вне конвейера)',
    '',
    '```bash',
    `git -C ${s.repoRoot} merge ${s.branch}`,
    `git -C ${s.repoRoot} worktree remove ${s.worktree}`,
    '```',
    '',
  ].join('\n');
  writeFileSync(path, md);
  return path;
}
