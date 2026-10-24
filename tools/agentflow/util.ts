import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function sha256(text: string): string {
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

/** Короткая форма хеша для логов. */
export function short(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 12);
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const c = (err as NodeJS.ErrnoException).code;
          code = typeof c === 'number' ? c : c === 'ENOENT' ? 127 : 1;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** glob → RegExp: поддерживает **, *, ?; пути с прямыми слешами. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Все файлы каталога рекурсивно, пути относительно root с прямыми слешами. */
export function listFiles(root: string, dir = root): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(listFiles(root, full));
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out.sort();
}

/**
 * Достаёт JSON-объект из ответа модели: последний ```json блок, затем любой
 * fenced-блок, затем текст от первой { до последней }.
 */
export function extractJson(text: string): unknown {
  const candidates: string[] = [];
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  candidates.push(...fences.reverse());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === 'object') return v;
    } catch {
      // следующий кандидат
    }
  }
  return undefined;
}

export function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Число со словом в нужной форме: «1 строка», «2 строки», «5 строк». */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  return `${n} ${d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** Метка для id запуска по местному времени: 20261018-235503. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Ошибка, которая останавливает run в BLOCKED с причиной в state.json. */
export class Blocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Blocked';
  }
}
