// Гейты запускает контроллер через run.sh; решение о переходе принимает код, а не роль.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.ts';
import { exec, now, oneLine } from './util.ts';
import type { GateRecord } from './state.ts';

export interface GateResult extends GateRecord {
  output: string;
}

export async function runGates(
  ops: string[],
  opts: { cwd: string; logDir: string; step: string; injectRed?: boolean },
): Promise<GateResult[]> {
  mkdirSync(opts.logDir, { recursive: true });
  const results: GateResult[] = [];
  for (const op of ops) {
    let r = await exec('bash', ['tools/agentflow/run.sh', op], { cwd: opts.cwd });
    let output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
    if (opts.injectRed && results.length === 0) {
      log.inject(`гейт ${op} принудительно красный`);
      r = { ...r, code: 1 };
      output = `[fault-injection] ${op}: принудительный провал гейта для проверки петли «гейты → implementer».\n` +
        'Исправлять в коде нечего: перезапусти ./tools/agentflow/run.sh ' + op + ' и подтверди, что он зелёный.\n\n' + output;
    }
    const logPath = join(opts.logDir, `${opts.step}-${op}.log`.replace(/[^\w.-]+/g, '_'));
    writeFileSync(logPath, output + '\n');
    const ok = r.code === 0;
    const lastLine = output.split('\n').filter(Boolean).pop() ?? '';
    log.gate(op, ok, oneLine(lastLine, 80));
    results.push({ op, ok, exitCode: r.code, step: opts.step, logPath, at: now(), output });
  }
  return results;
}

export function gatesSummary(results: GateResult[], tail = 60): string {
  return results
    .map((g) => {
      const lines = g.output.split('\n');
      const body = g.ok ? '' : '\n```\n' + lines.slice(-tail).join('\n') + '\n```';
      return `- ${g.op}: ${g.ok ? 'зелёный' : 'КРАСНЫЙ'} (код ${g.exitCode}, лог ${g.logPath})${body}`;
    })
    .join('\n');
}
