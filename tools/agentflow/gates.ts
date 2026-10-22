// Гейты запускает контроллер через agentflow-gate (команды из gates.ops policy);
// решение о переходе принимает код, а не роль.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_BIN } from './config.ts';
import { log } from './log.ts';
import { gateEnv, type Policy } from './policy.ts';
import { exec, now, oneLine } from './util.ts';
import type { GateRecord } from './state.ts';

export interface GateResult extends GateRecord {
  output: string;
}

export async function runGates(
  ops: string[],
  opts: { cwd: string; logDir: string; step: string; policy: Policy; injectRed?: boolean },
): Promise<GateResult[]> {
  mkdirSync(opts.logDir, { recursive: true });
  const results: GateResult[] = [];
  for (const op of ops) {
    log.gateStart(op);
    let r = await exec('bash', [join(KIT_BIN, 'agentflow-gate'), op], { cwd: opts.cwd, env: { ...process.env, ...gateEnv(opts.policy) } });
    let output = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
    if (opts.injectRed && results.length === 0) {
      log.inject(`гейт ${op} принудительно красный`);
      r = { ...r, code: 1 };
      output = `[fault-injection] ${op}: принудительный провал гейта для проверки петли «гейты → implementer».\n` +
        'Исправлять в коде нечего: перезапусти agentflow-gate ' + op + ' и подтверди, что он зелёный.\n\n' + output;
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
