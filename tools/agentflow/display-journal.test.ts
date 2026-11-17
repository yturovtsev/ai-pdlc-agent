import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DisplayJournal, RunStore } from './state.ts';

test('журнал отображения: страницы, повторное чтение, отдельный файл участка, events не меняется', () => {
  const store = new RunStore(mkdtempSync(join(tmpdir(), 'display-journal-')));
  store.append({ ev: 'before' });
  const before = readFileSync(store.ledgerPath);
  const a = store.createDisplayJournal();
  const b = store.createDisplayJournal();
  assert.notEqual(a.path, b.path);
  const texts = Array.from({ length: 200 }, (_, i) => `L${String(i + 1).padStart(4, '0')}`);
  texts.forEach((text) => a.append({ kind: 'line', text }));
  b.append({ kind: 'line', text: 'другой участок' });
  a.close(); b.close();
  const reopened = DisplayJournal.open(a.path);
  assert.equal(reopened.length, 200);
  assert.deepEqual([reopened.page(0, 73), reopened.page(73, 127)].flat().map((e) => e.kind === 'line' && e.text), texts);
  assert.deepEqual(reopened.page(198, 20).map((e) => e.id), [198, 199]);
  reopened.close(); reopened.close();
  assert.deepEqual(readFileSync(store.ledgerPath), before);
});

test('новый процесс создаёт отдельный журнал и сохраняет прежние bytes', () => {
  const store = new RunStore(mkdtempSync(join(tmpdir(), 'display-process-')));
  const journal = store.createDisplayJournal();
  journal.append({ kind: 'line', text: 'FIRST' }); journal.close();
  const before = readFileSync(journal.path);
  const script = `import { RunStore } from './tools/agentflow/state.ts'; const j = new RunStore(${JSON.stringify(store.runDir)}).createDisplayJournal(); j.append({kind: 'line', text: 'SECOND'}); console.log(j.path); j.close();`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.notEqual(child.stdout.trim(), journal.path);
  assert.deepEqual(readFileSync(journal.path), before);
});
