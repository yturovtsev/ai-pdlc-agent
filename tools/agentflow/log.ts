// Консольный рендер конвейера: фазы, петли с номером раунда, запуск субагентов,
// их вызовы инструментов, решения ACL, гейты и вердикты. Всё дублируется в events.jsonl.
import type { AclCategory, AclDecision } from './roles.ts';
import { screen, textWidth, wrapText, type ThinkingView } from './screen.ts';
import type { DenialGroup } from './session-tracker.ts';
import { fit, panel } from './status-panel.ts';
import { oneLine, pluralRu } from './util.ts';

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

// Пока открыт диалог, строки копятся здесь и выходят после него: меню inquirer не рвётся
// параллельным выводом работающей сессии. events.jsonl пишется сразу.
const HELD_MAX = 2000;
let held = 0;
let buffer: { s: string; view?: ThinkingView }[] = [];
let dropped = 0;

const indent = () => c.gray('│ '.repeat(depth));

function line(text: string, view?: ThinkingView): void {
  const s = indent() + text;
  if (!held) return print(s, view);
  if (buffer.length < HELD_MAX) buffer.push({ s, view });
  else dropped++;
}

/** Строка размышления встаёт на экран в момент фактического вывода: после удержания — при release. */
function print(s: string, view?: ThinkingView): void {
  const mark = view && screen.mark();
  console.log(s);
  if (mark) screen.register(mark, view!);
}

/** Текст размышления для раскрытия: без управляющих символов, пустые строки схлопнуты, перенос по ширине. */
export function thinkingLines(text: string, width: number): string[] {
  const out: string[] = [];
  const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  for (const raw of clean.split('\n')) {
    const l = raw.trimEnd();
    if (l) out.push(...wrapText(l, width));
    else if (out.length && out.at(-1) !== '') out.push('');
  }
  while (out.at(-1) === '') out.pop();
  return out;
}

/** Строка о скрытой части раскрытого размышления. */
export function moreLines(hidden: number): string {
  return `… ещё ${pluralRu(hidden, 'строка', 'строки', 'строк')} — целиком в events.jsonl`;
}

/** Местное время события HH:MM:SS. */
export function clockTime(at: number = Date.now()): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function emit(ev: string, data: Record<string, unknown>): void {
  sink?.({ ev, ...data });
}

export const paintRole = (role: string, s: string) => (roleColor[role] ?? c.bold)(s);

/** Метка категории отказа: ожидаемое серым, то, что требует правки policy или настроек CLI, — жёлтым. */
export function categoryLabel(category: AclCategory | 'cli' | undefined): string {
  if (category === 'permission') return c.yellow('не хватает разрешения');
  if (category === 'cli') return c.yellow('отклонено CLI');
  return c.gray('ожидаемо');
}

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
        c.gray(` · ${clockTime()} [модель ${info.model} · effort ${info.effort ?? 'по умолчанию'} · ${how}]`),
    );
    line(c.gray(`  инструменты: ${info.tools.join(', ')}`));
    emit('spawn', { role, ...info });
    panel.update((s) => {
      const at = Date.now();
      s.launches++;
      s.sessions = (s.sessions ?? 0) + 1;
      s.agent = { role, target: info.target, model: info.model, effort: info.effort, resume: info.resume, startedAt: at, tools: 0, step: { label: 'ждёт ответа модели', since: at } };
    });
  },

  /** Строка события роли: время прихода события сразу после имени — видно, с какого момента роль на этом шаге. */
  role(role: string, text: string): void {
    line(paintRole(role, `  ${role} │ `) + c.gray(clockTime()) + ' ' + text);
  },

  /**
   * Размышление роли. В режиме мыши строка свёрнута (▸) и раскрывается кликом: текст рисует экран
   * по этому описанию. Без режима мыши — прежняя строка с числом символов.
   */
  thinking(role: string, text: string): void {
    const chars = `размышляет (${text.length} симв.)`;
    if (!screen.active() || !text.trim()) return log.role(role, c.gray(`… ${chars}`));
    const pre = indent();
    const name = paintRole(role, `  ${role} │ `);
    const time = clockTime();
    const header = (open: boolean) => name + c.gray(time) + ' ' + c.gray(`${open ? '▾' : '▸'} ${chars}`);
    // Текст стоит под временем строки; в узком окне — без префикса, лишь бы терминал не переносил строки.
    const lead = textWidth(pre + name) + time.length + 1;
    const pad = (columns: number) =>
      columns - lead - 1 >= 20 ? { p: pre + name + ' '.repeat(time.length + 1), w: columns - lead - 1 } : { p: '  ', w: columns - 3 };
    line(header(false), {
      header: (open) => pre + header(open),
      body: (columns) => {
        const { p, w } = pad(columns);
        return thinkingLines(text, w).map((l) => p + c.gray(l));
      },
      more: (hidden, columns) => {
        const { p, w } = pad(columns);
        return p + c.gray(fit(moreLines(hidden), w));
      },
    });
  },

  /** Глубина вложенности петель. Петля, пройденная решением человека посреди раунда, возвращает прежнюю. */
  depth(set?: number): number {
    if (set !== undefined) depth = set;
    return depth;
  },

  /** Удержать вывод на время диалога; вложенные удержания складываются. */
  hold(): void {
    held++;
  },

  release(): void {
    if (!held || --held) return;
    const out = buffer;
    buffer = [];
    for (const { s, view } of out) print(s, view);
    if (dropped) console.log(c.gray(`… ещё ${dropped} строк лога не показано — они в events.jsonl`));
    dropped = 0;
  },

  /** Вызов инструмента роли: строка лога и счётчик инструментов в панели. */
  toolUse(role: string, name: string, arg: string): void {
    log.role(role, `→ ${name} ${arg}`);
    panel.update((s) => {
      if (s.agent) s.agent.tools++;
    });
  },

  roleDone(role: string, info: { turns: number; seconds: number; models: string[]; denials: number; groups?: DenialGroup[] }): void {
    const { groups = [], ...done } = info;
    const models = info.models.length ? info.models.join(', ') : 'не сообщена';
    line(
      paintRole(role, `■ ${role} завершил`) +
        c.gray(` · ${info.turns} ходов · ${info.seconds} с · модель из ответа API: ${models}`) +
        (info.denials ? c.yellow(` · отказов ACL: ${info.denials}`) : ''),
    );
    emit('role-done', { role, ...done });
    log.denials(role, groups);
  },

  /** Голое число отказов ничего не объясняет: по группе — что отклонено, почему и что делать. */
  denials(role: string, groups: DenialGroup[]): void {
    if (!groups.length) return;
    for (const g of groups) {
      line(paintRole(role, `  ${role} │ `) + `${c.red('✗')} ${g.count}× ${g.tool} ${oneLine(g.target, 90)} — ${g.reason} · ${categoryLabel(g.category)}`);
      line(paintRole(role, `  ${role} │ `) + c.gray(`  что делать: ${g.hint}`));
    }
    emit('denials', { role, groups });
  },

  /** Сессия закрыта любым путём (ответ, падение CLI, прерывание): панель перестаёт её считать. */
  roleEnd(role: string, ok: boolean): void {
    panel.update((s) => {
      s.sessions = Math.max(0, (s.sessions ?? 1) - 1);
      s.agent = undefined;
      s.activity = ok ? `${role} завершил` : `${role}: сессия без ответа`;
      s.activitySince = Date.now();
    });
  },

  /** Состояние сессии из SessionTracker: текущий шаг, вложенные субагенты, отказы ACL. */
  session(view: { step: { label: string; since: number }; nested: number; denials: number; lastDenial?: string }): void {
    panel.update((s) => {
      if (!s.agent) return;
      s.agent.step = view.step;
      s.agent.nested = view.nested;
      s.agent.denials = { count: view.denials, last: view.lastDenial };
    });
  },

  acl(role: string, tool: string, d: AclDecision): void {
    const mark = d.ok ? c.green('✓ ACL') : c.red('✗ ACL');
    log.role(role, `${mark} ${tool} ${oneLine(d.target, 90)}` + (d.ok ? '' : c.red(` — ${d.reason}`) + ` · ${categoryLabel(d.category)}`));
    if (!d.ok && d.hint) log.role(role, c.gray(`  что делать: ${d.hint}`));
    emit('acl', { role, tool, target: d.target, allowed: d.ok, reason: d.reason, ...(d.ok ? {} : { category: d.category, hint: d.hint }) });
  },

  step(text: string): void {
    line(c.gray('⚙ ') + text);
    emit('step', { text });
    panel.update({ activity: oneLine(text, 160), activitySince: Date.now() });
  },

  gate(op: string, ok: boolean, detail: string): void {
    line((ok ? c.green('● гейт ') : c.red('● гейт ')) + `${op}: ` + (ok ? c.green('зелёный') : c.red('красный')) + c.gray(detail ? ` · ${detail}` : ''));
    emit('gate', { op, ok, detail });
    panel.update({ activity: `гейт ${op}: ${ok ? 'зелёный' : 'красный'}`, activitySince: Date.now() });
  },

  /** Гейт контроллера запущен: в панели виден с начала, а не только по итогу. В лог не пишется. */
  gateStart(op: string): void {
    panel.update({ activity: `гейт ${op} выполняется`, activitySince: Date.now() });
  },

  verdict(status: string, summary: string, next: string): void {
    line(verdictColor(status)(`◆ вердикт ${status}`) + c.gray(` · ${summary}`) + ` → ${next}`);
    emit('verdict', { status, summary, next });
    panel.update({ activity: `вердикт ${status} → ${oneLine(next, 80)}`, activitySince: Date.now() });
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

  /** Ответ роли в обсуждении вопроса: блок под вопросом, целиком — и в консоль, и в events.jsonl. */
  discuss(role: string, answer: string): void {
    line(c.bold(c.cyan(`💬 ${role} отвечает:`)));
    for (const l of answer.split('\n')) line('   ' + l);
    emit('discuss', { role, answer });
  },

  human(text: string): void {
    line(c.bold(c.yellow('☺ ты: ')) + text);
    emit('human', { text });
    panel.update({ activity: 'решение человека', activitySince: Date.now() });
  },
};
