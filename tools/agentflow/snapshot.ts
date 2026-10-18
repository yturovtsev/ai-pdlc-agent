// Snapshot артефакта — sha256 его текста и digest принятых upstream-артефактов.
// Snapshot кода — base/head и хеш diff. Вердикт действителен только для своего snapshot.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globToRegExp, listFiles, sha256 } from './util.ts';

/** Нормализация: переводы строк, хвостовые пробелы, галочки задач (прогресс не ломает digest). */
export function normalize(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, '').replace(/^(\s*- )\[[ xX]\]/, '$1[ ]'))
    .join('\n')
    .trim() + '\n';
}

export function artifactFiles(changeDir: string, generates: string): string[] {
  const re = globToRegExp(generates);
  return listFiles(changeDir).filter((f) => re.test(f));
}

export function artifactText(changeDir: string, generates: string): string {
  return artifactFiles(changeDir, generates)
    .map((f) => `--- ${f}\n${normalize(readFileSync(join(changeDir, f), 'utf8'))}`)
    .join('\n');
}

export function artifactSnapshot(changeDir: string, generates: string, upstream: string[]): string {
  return sha256(artifactText(changeDir, generates) + '\n--- upstream\n' + [...upstream].sort().join('\n'));
}

/** Digest замороженной спеки: все артефакты change в нормализованном виде. */
export function specDigest(changeDir: string, generatesList: string[]): string {
  return sha256(generatesList.map((g) => artifactText(changeDir, g)).join('\n'));
}

export function codeSnapshot(base: string, headSha: string, diffText: string): string {
  return sha256(`${base}..${headSha}\n${diffText}`);
}
