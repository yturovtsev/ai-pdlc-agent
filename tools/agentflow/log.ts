// Консольный рендер конвейера: фазы, петли с номером раунда, запуск субагентов,
// их вызовы инструментов, решения ACL, гейты и вердикты. Всё дублируется в events.jsonl.
import { panel } from './status-panel.ts';
import { oneLine } from './util.ts';

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  gray: paint('90'),
};

// Цвет по семейству модели роли: Qwen, DeepSeek, GLM — как на схеме архитектуры.
const roleColor: Record<string, (s: string) => string> = {
  'spec-author': c.magenta,
  'acceptance-tester': c.magenta,
  'spec-reviewer': c.blue,
  implementer: c.blue,
  'code-reviewer': c.cyan,
};

type Sink = (event: Record<string, unknown>) => void;
let sink: Sink | undefined;
let depth = 0;

export function setLogSink(fn: Sink): void {
  sink = fn;
}

function line(text: string): void {
  console.log(c.gray('│ '.repeat(depth)) + text);
}

function emit(ev: string, data: Record<string, unknown>): void {
  sink?.({ ev, ...data });
}

export const paintRole = (role: string, s: string) => (roleColor[role] ?? c.bold)(s);

const verdictColor = (status: string) =>
  status === 'PASS' ? c.green : status === 'BLOCKED' ? c.red : c.yellow;

export const log = {
  phase(title: string): void {
    depth = 0;
    const bar = '═'.repeat(72);
    console.log('\n' + c.bold(bar) + '\n' + c.bold(' ' + title) + '\n' + c.bold(bar));
    emit('phase', { title });
    panel.update({ phase: title, loop: undefined });
  },

  loopOpen(name: string, round: number, max: number): void {
    line(c.bold(`┌─ петля «${name}» · раунд ${round}/${max}`));
    depth++;
    emit('loop', { name, round, max });
    panel.update({ loop: { name, round, max } });
  },

  loopClose(text: string): void {
    depth = Math.max(0, depth - 1);
    line(c.bold(`└─ ${text}`));
    panel.update({ loop: undefined });
  },

  spawn(role: string, info: { model: string; effort?: string; session: string; resume: boolean; tools: string[]; target?: string }): void {
    const how = info.resume ? `продолжение сессии ${info.session.slice(0, 8)}` : `новая сессия ${info.session.slice(0, 8)}`;
    line(
      paintRole(role, `▶ субагент ${role}`) +
        c.gray(` [модель ${info.model} · effort ${info.effort ?? 'по умолчанию'} · ${how}]`),
    );
    line(c.gray(`  инструменты: ${info.tools.join(', ')}`));
    emit('spawn', { role, ...info });
    panel.update((s) => {
      s.launches++;
      s.agent = { role, target: info.target, model: info.model, effort: info.effort, resume: info.resume, startedAt: Date.now(), tools: 0 };
    });
  },

  role(role: string, text: string): void {
    line(paintRole(role, `  ${role} │ `) + text);
  },

  /** Вызов инструмента роли: строка лога и счётчик инструментов в панели. */
  toolUse(role: string, name: string, arg: string): void {
    log.role(role, `→ ${name} ${arg}`);
    panel.update((s) => {
      if (s.agent) s.agent.tools++;
    });
  },

  roleDone(role: string, info: { turns: number; seconds: number; models: string[]; denials: number }): void {
    const models = info.models.length ? info.models.join(', ') : 'не сообщена';
    line(
      paintRole(role, `■ ${role} завершил`) +
        c.gray(` · ${info.turns} ходов · ${info.seconds} с · модель из ответа API: ${models}`) +
        (info.denials ? c.yellow(` · отказов ACL: ${info.denials}`) : ''),
    );
    emit('role-done', { role, ...info });
    panel.update({ agent: undefined, activity: `${role} завершил` });
  },

  acl(role: string, tool: string, target: string, allowed: boolean, reason: string): void {
    const mark = allowed ? c.green('✓ ACL') : c.red('✗ ACL');
    line(paintRole(role, `  ${role} │ `) + `${mark} ${tool} ${oneLine(target, 90)}` + (allowed ? '' : c.red(` — ${reason}`)));
    emit('acl', { role, tool, target, allowed, reason });
  },

  step(text: string): void {
    line(c.gray('⚙ ') + text);
    emit('step', { text });
    panel.update({ activity: oneLine(text, 160) });
  },

  gate(op: string, ok: boolean, detail: string): void {
    line((ok ? c.green('● гейт ') : c.red('● гейт ')) + `${op}: ` + (ok ? c.green('зелёный') : c.red('красный')) + c.gray(detail ? ` · ${detail}` : ''));
    emit('gate', { op, ok, detail });
    panel.update({ activity: `гейт ${op}: ${ok ? 'зелёный' : 'красный'}` });
  },

  verdict(status: string, summary: string, next: string): void {
    line(verdictColor(status)(`◆ вердикт ${status}`) + c.gray(` · ${summary}`) + ` → ${next}`);
    emit('verdict', { status, summary, next });
    panel.update({ activity: `вердикт ${status} → ${oneLine(next, 80)}` });
  },

  inject(text: string): void {
    line(c.yellow(`⚡ fault injection: ${text}`));
    emit('inject', { text });
  },

  info(text: string): void {
    line(text);
    emit('info', { text });
  },

  warn(text: string): void {
    line(c.yellow('! ' + text));
    emit('warn', { text });
  },

  error(text: string): void {
    line(c.red('✗ ' + text));
    emit('error', { text });
  },

  human(text: string): void {
    line(c.bold(c.yellow('☺ ты: ')) + text);
    emit('human', { text });
    panel.update({ activity: 'решение человека' });
  },
};
