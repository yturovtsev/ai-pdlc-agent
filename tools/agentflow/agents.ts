// Список субагентов прогона из events.jsonl: каждая сессия SDK — отдельный процесс CLI
// со своей ролью, моделью и id сессии. Доказательство, что работает не один агент.
//   npm run agentflow -- agents <run-id>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { c } from './log.ts';

interface SessionRow {
  session: string;
  role: string;
  requested: string;
  effort: string;
  initModel: string;
  apiModels: Set<string>;
  tools: number;
  mode: string;
  calls: number;
  turns: number;
  steps: string[];
  first: string;
  last: string;
}

export function collectSessions(runDir: string): SessionRow[] {
  const rows = new Map<string, SessionRow>();
  const row = (session: string, role: string): SessionRow => {
    let r = rows.get(session);
    if (!r) {
      r = { session, role, requested: '', effort: '', initModel: '', apiModels: new Set(), tools: 0, mode: '', calls: 0, turns: 0, steps: [], first: '', last: '' };
      rows.set(session, r);
    }
    return r;
  };
  for (const line of readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n')) {
    if (!line.includes('"ev":"spawn"') && !line.includes('"ev":"sdk"')) continue;
    const e = JSON.parse(line) as Record<string, any>;
    if (e['ev'] === 'spawn') {
      const r = row(e['session'], e['role']);
      r.requested = String(e['model']);
      r.effort = e['effort'] ?? 'по умолчанию';
      r.calls++;
      r.first ||= e['at'];
      continue;
    }
    const m = e['msg'] ?? {};
    if (!m.session_id) continue;
    const r = row(m.session_id, e['role']);
    r.last = e['at'];
    if (e['step'] && !r.steps.includes(e['step'])) r.steps.push(e['step']);
    if (m.type === 'system' && m.subtype === 'init') {
      r.initModel = m.model ?? '';
      r.tools = m.tools?.length ?? 0;
      r.mode = m.permission_mode ?? '';
    } else if (m.type === 'assistant' && m.message?.model) {
      r.apiModels.add(m.message.model);
    } else if (m.type === 'result') {
      r.turns += m.num_turns ?? 0;
    }
  }
  return [...rows.values()].sort((a, b) => a.first.localeCompare(b.first));
}

export function showAgents(runDir: string): void {
  const rows = collectSessions(runDir);
  if (!rows.length) {
    console.log('в events.jsonl нет сессий субагентов');
    return;
  }
  const time = (iso: string) => (iso ? new Date(iso).toLocaleTimeString() : '—');
  console.log(c.bold('#   роль               сессия    модель (запрошена → init → ответ API)              effort  вызовов ходов  время           шаги'));
  rows.forEach((r, i) => {
    const api = [...r.apiModels].join(', ') || '—';
    console.log(
      `${String(i + 1).padEnd(3)} ${r.role.padEnd(18)} ${r.session.slice(0, 8)}  ${`${r.requested} → ${r.initModel || '—'} → ${api}`.padEnd(50)} ${r.effort.padEnd(7)} ${String(r.calls).padStart(7)} ${String(r.turns).padStart(5)}  ${time(r.first)}–${time(r.last)}  ${r.steps.join(', ')}`,
    );
  });
  const roles = new Set(rows.map((r) => r.role));
  const models = new Set(rows.flatMap((r) => [...r.apiModels]));
  console.log(
    `\nИтого: ${rows.length} отдельных сессий CLI, ${roles.size} ролей (${[...roles].join(', ')}), ` +
      `моделей по ответам API: ${models.size} (${[...models].join(', ') || '—'}).`,
  );
  console.log(c.gray('Сессии идут последовательно: в каждый момент файлы пишет одна роль. «вызовов» > 1 — раунд исправлений через resume той же сессии.'));
}
