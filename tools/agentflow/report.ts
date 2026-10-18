// ACCEPTANCE.md — отчёт для человеческой приёмки и сводка пройденных петель.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { c } from './log.ts';
import type { RunState } from './state.ts';
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

export function writeAcceptanceReport(runDir: string, s: RunState, manualCheck: string): string {
  const path = join(runDir, 'ACCEPTANCE.md');
  const trace = (s.final?.traceability ?? []) as { requirementId: string; scenarioId?: string; code?: string[]; tests?: string[]; evidence?: string; result: string }[];
  const acc = s.acceptance?.report as { checks?: { id: string; result: string; note?: string }[] } | undefined;
  const logged = s.findings.filter((f) => f.status === 'logged');
  const open = s.findings.filter((f) => f.status === 'open');
  const usage = Object.entries(s.usage);
  const md = [
    `# Приёмка: ${s.change}`,
    '',
    `Статус конвейера: **${s.status === 'running' ? 'готово к приёмке' : s.status.toUpperCase()}**${s.stopReason ? ` — ${s.stopReason}` : ''}.`,
    '',
    `- run: \`${s.runId}\``,
    `- ветка: \`${s.branch}\`, worktree: \`${s.worktree}\``,
    `- база: \`${s.baseCommit.slice(0, 10)}\`, digest спеки: \`${s.spec.freeze ? short(s.spec.freeze.digest) : 'не заморожена'}\``,
    '',
    '## Пройденные петли',
    '',
    '| Петля | Раундов | Вердикты |',
    '| --- | --- | --- |',
    ...loopSummary(s).map((r) => `| ${r.loop} | ${r.rounds} | ${r.path} |`),
    '',
    '## Трассировка требований (финальное ревью)',
    '',
    trace.length ? '| Требование | Сценарий | Код | Тесты | Evidence | Итог |\n| --- | --- | --- | --- | --- | --- |' : '(финальное ревью не пройдено)',
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
    manualCheck || `cd ${s.worktree} && npm --prefix ${s.repoRoot} run lint`,
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
