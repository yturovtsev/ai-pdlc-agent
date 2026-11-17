import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Human, type PromptIO } from './human.ts';
import { configureThinking, log, renderRecord, setDisplaySink, writeThinkingFile } from './log.ts';
import { LogView } from './log-view.ts';
import { DisplayJournal, RunStore } from './state.ts';
import { panel } from './status-panel.ts';
import { startTerminalSession } from './terminal-session.ts';
import { FakeInput, FakeTerminal } from './test-support/terminal.ts';

function fixture(noPanel = false, rows = 30, columns = 120) {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-session-'));
  const store = new RunStore(dir);
  const input = new FakeInput();
  const out = new FakeTerminal(rows, columns);
  out.write('BEFORE-RUN\n');
  configureThinking({ chars: 200, dir: join(dir, 'thinking') });
  const session = startTerminalSession({ store, input, out, noPanel, panel: { runId: 'run1', change: 'demo', roles: 5, launches: 0 } });
  return { dir, store, input, out, session, lines: () => out.vt.lines().join('\n'),
    wheel: (up: boolean) => out.vt.wheel(up, input),
    click: (text: string) => { const row = out.vt.row(text); assert.ok(row > 0, text); out.vt.click(row, input); },
    close: () => { session.close(); configureThinking({ chars: 300, dir: null, links: false }); },
  };
}
const lines = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(4, '0')}`).join('\n');
function data() {
  log.write(lines('L', 100));
  log.thinking('spec-author', lines('T', 80));
  for (let i = 101; i <= 200; i++) log.write(`L${String(i).padStart(4, '0')}`);
  log.thinking('spec-author', 'SHORT-THINKING');
  log.thinking('spec-author', lines('TAIL', 40));
}

test('окно: медленные шаги и быстрые 15 вверх/7 вниз двигают кадр без отключения отчёта', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    data();
    for (let i = 0; i < 5; i++) {
      const before = f.out.vt.lines(); f.wheel(true);
      assert.deepEqual(f.out.vt.lines().slice(1, 27), before.slice(0, 26));
      assert.ok(f.out.vt.reporting); t.mock.timers.tick(1100);
    }
    const before = f.out.vt.lines();
    for (let i = 0; i < 15; i++) f.wheel(true);
    for (let i = 0; i < 7; i++) f.wheel(false);
    assert.deepEqual(f.out.vt.lines().slice(8, 27), before.slice(0, 19));
    for (let i = 0; i < 1000; i++) f.wheel(true);
    assert.equal(f.out.vt.lines()[0], 'L0001');
    const top = f.lines(); f.wheel(true); assert.equal(f.lines(), top);
    for (let i = 0; i < 1000; i++) f.wheel(false);
    f.click('▸'); assert.match(f.lines(), /▾/);
  } finally { f.close(); }
});

test('якорь: новый лог и панель не сбрасывают чтение; End возвращает слежение', () => {
  const f = fixture();
  try {
    data();
    for (let i = 0; i < 150; i++) f.wheel(true);
    const before = f.out.vt.lines().slice(0, 27);
    log.write(lines('NEW', 20)); panel.update({ activity: 'АКТУАЛЬНЫЙ-ШАГ' });
    assert.deepEqual(f.out.vt.lines().slice(0, 27), before);
    assert.match(f.lines(), /АКТУАЛЬНЫЙ-ШАГ/);
    f.input.emit('data', '\x1b[F'); log.write('AFTER-ACTION');
    assert.match(f.lines(), /AFTER-ACTION/);
    log.write('AFTER-SECOND'); assert.match(f.lines(), /AFTER-SECOND/);
  } finally { f.close(); }
});

for (const noPanel of [true, false]) for (const scrollback of [true, false]) {
  test(`полный текст и сохранность записей: noPanel=${noPanel}, scrollback=${scrollback}`, () => {
    const f = fixture(noPanel);
    try {
      f.out.vt.scrollbackWithStatus = scrollback;
      data();
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let i = 0; i < 1000; i++) f.wheel(true);
        for (let i = 0; i < 200 && !f.out.vt.row('▸'); i++) f.wheel(false);
        // Клавишами можно поставить заголовок у первой строки и раскрыть без свободного места сверху.
        while (f.out.vt.row('▸') > 1) f.wheel(false);
        assert.equal(f.out.vt.row('▸'), 1);
        f.click('▸');
        const seen = new Set<string>();
        for (let i = 0; i < 100; i++) {
          for (const marker of f.lines().match(/\bT\d{4}\b/g) ?? []) seen.add(marker);
          if (f.out.vt.row('Свернуть')) break;
          f.wheel(false);
        }
        assert.equal(seen.size, 80);
        f.click('Свернуть');
      }
      log.write('AFTER-ACTION');
      f.session.close(); f.session.close();
      const transcript = f.out.writes.join('').split('\x1b[?1049l').at(-1)!;
      assert.deepEqual(transcript.match(/^L\d{4}$/gm), lines('L', 200).split('\n'));
      assert.equal(transcript.match(/AFTER-ACTION/g)?.length, 1);
      assert.ok(!f.out.vt.alternate && !f.input.raw && !f.out.vt.reporting);
      assert.match([...f.out.vt.history, ...f.out.vt.lines()].join('\n'), /BEFORE-RUN/);
      assert.doesNotMatch(transcript, /▾|Свернуть/);
    } finally { f.close(); }
  });
}

test('resize: старые блоки доступны при 30×120, 10×40, 8×30; промахи и короткий текст', () => {
  const f = fixture();
  try {
    log.write('L0001'); log.thinking('spec-author', lines('T', 80));
    for (const [rows, cols] of [[30, 120], [10, 40], [8, 30], [30, 120]]) {
      f.out.resize(rows!, cols!);
      for (let i = 0; i < 100 && !f.out.vt.row('▸'); i++) f.wheel(true);
      f.click('▸'); assert.match(f.lines(), /▾/);
      f.click('▾'); assert.match(f.lines(), /▸/);
      assert.equal(f.out.vt.row('контроллер') > 0, rows! >= 10 && cols! >= 40);
    }
    for (let i = 0; i < 100; i++) f.wheel(true);
    f.out.vt.click(1, f.input); assert.doesNotMatch(f.lines(), /▾/);
    f.out.vt.click(30, f.input); assert.doesNotMatch(f.lines(), /▾/);
    f.input.emit('data', '\x1b[F'); log.thinking('spec-author', 'SHORT-THINKING');
    f.click('SHORT-THINKING'); assert.doesNotMatch(f.lines(), /▾/);
  } finally { f.close(); }
});

test('колесо запрещено профилем: физический шаг не доставляется; PageUp/PageDown/End работают', () => {
  const f = fixture(true);
  try {
    data(); f.out.vt.wheelAllowed = false;
    const before = f.lines(); f.wheel(true); assert.equal(f.lines(), before);
    f.input.emit('data', '\x1b[5'); f.input.emit('data', '~'); assert.notEqual(f.lines(), before);
    f.input.emit('data', '\x1b[6~'); assert.equal(f.lines(), before);
    f.input.emit('data', '\x1b[5~\x1b[F'); assert.equal(f.lines(), before);
  } finally { f.close(); }
});

test('диалог: мышь/raw сняты, события удержаны, якорь и open восстановлены, итог один', async () => {
  const f = fixture();
  try {
    data(); f.click('▸');
    const before = f.out.vt.lines().slice(0, 27);
    const listeners = f.input.listenerCount('data');
    const io = { tty: () => true, select: async () => {
      assert.equal(f.input.raw, false); assert.equal(f.out.vt.reporting, false);
      assert.equal(f.input.listenerCount('data'), 0);
      assert.doesNotMatch(f.lines(), /контроллер/);
      log.write('DURING-DIALOG'); assert.doesNotMatch(f.lines(), /DURING-DIALOG/);
      const journalPath = join(f.dir, 'display', readdirSync(join(f.dir, 'display'))[0]!);
      assert.match(readFileSync(journalPath, 'utf8'), /DURING-DIALOG/);
      f.out.write('? вопрос\n❯ один\n  два\x1b[2A\x1b[G\x1b[2B✔ вопрос два\n');
      return 'b';
    } } as unknown as PromptIO;
    const selected = await new Human(false, io).select({ title: 'ВОПРОС', options: [{ key: 'a', label: 'один' }, { key: 'b', label: 'два' }], recommended: 'a', rationale: 'причина' });
    assert.equal(selected, 'b');
    assert.deepEqual(f.out.vt.lines().slice(0, 27), before);
    assert.equal(f.input.listenerCount('data'), listeners);
    assert.ok(f.input.raw && f.out.vt.reporting);
    f.session.close();
    const transcript = f.out.writes.join('').split('\x1b[?1049l').at(-1)!;
    assert.equal(transcript.match(/выбрано: два/g)?.length, 1);
    assert.equal(transcript.match(/DURING-DIALOG/g)?.length, 1);
    assert.doesNotMatch(transcript, /❯|✔ вопрос/);
  } finally { f.close(); }
});

test('модель: кэш вытесняется без потерь, preview 0 и якорь после новых записей', () => {
  const store = new RunStore(mkdtempSync(join(tmpdir(), 'log-view-')));
  const journal = store.createDisplayJournal();
  const view = new LogView(journal, 4, 2);
  view.resize(40, 8);
  for (let i = 1; i <= 200; i++) view.append({ kind: 'line', text: `L${String(i).padStart(4, '0')}` });
  view.scroll(-10000);
  assert.match(view.frame()[0]!.text, /L0001/);
  view.append({ kind: 'line', text: 'NEW' }); assert.match(view.frame()[0]!.text, /L0001/);
  view.end(); assert.match(view.frame().at(-1)!.text, /NEW/);
  view.append({ kind: 'thinking', role: 'spec-author', pre: '', name: '', time: '', text: lines('T', 80), chars: 0 });
  view.toggle(201);
  view.scroll(10000); assert.match(view.frame().at(-1)!.text, /Свернуть/);
  view.toggle(201); assert.match(view.frame().map((l) => l.text).join('\n'), /Развернуть/);
  journal.close();
});

test('ссылки: коллизия UUID, старый файл, пробел и #, несколько процессов', () => {
  const dir = mkdtempSync(join(tmpdir(), 'thinking # '));
  const old = join(dir, '0001-spec-author.md'); writeFileSync(old, 'OLD');
  writeFileSync(join(dir, 'collision-spec-author.md'), 'COLLISION');
  let n = 0;
  const path = writeThinkingFile(dir, 'spec-author', 'NEW', () => ++n === 1 ? 'collision' : 'unique');
  assert.match(path, /unique/); assert.equal(readFileSync(old, 'utf8'), 'OLD');
  const module = resolve('tools/agentflow/log.ts');
  const urls: string[] = [];
  for (const text of ['FIRST-SESSION', 'SECOND-SESSION', 'THIRD-SESSION']) {
    const script = `import { configureThinking, log } from ${JSON.stringify(module)}; configureThinking({dir: ${JSON.stringify(dir)}, links: true, chars: 0}); log.thinking('spec-author', ${JSON.stringify(text)});`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const url = result.stdout.match(/\x1b\]8;;(file:[^\x07]+)\x07/)![1]!;
    assert.match(url, /%23/); assert.match(url, /%20/);
    urls.push(url); assert.match(readFileSync(fileURLToPath(url), 'utf8'), new RegExp(text));
  }
  assert.equal(new Set(urls).size, 3);
  assert.match(readFileSync(fileURLToPath(urls[0]!), 'utf8'), /FIRST-SESSION/);
  assert.equal(readFileSync(old, 'utf8'), 'OLD');
  assert.equal(readFileSync(join(dir, 'collision-spec-author.md'), 'utf8'), 'COLLISION');
});

test('одновременные процессы не перезаписывают файлы размышлений', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thinking-concurrent-'));
  const urls = await Promise.all(Array.from({ length: 4 }, async (_, i) => {
    const text = `CONCURRENT-${i}`;
    const script = `import { configureThinking, log } from './tools/agentflow/log.ts'; configureThinking({dir:${JSON.stringify(dir)}, links:true, chars:0}); log.thinking('spec-author',${JSON.stringify(text)});`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (data: Buffer) => { output += String(data); }); child.stderr.resume();
    const [code] = await once(child, 'close'); assert.equal(code, 0);
    const url = output.match(/\x1b\]8;;(file:[^\x07]+)\x07/)![1]!;
    assert.match(readFileSync(fileURLToPath(url), 'utf8'), new RegExp(text));
    return url;
  }));
  assert.equal(new Set(urls).size, 4);
});

test('ссылки раскрытого блока и transcript открывают тот же полный файл; ошибка записи без битой ссылки', () => {
  const f = fixture(true);
  try {
    log.thinking('spec-author', lines('T', 80)); f.click('Развернуть');
    const url = f.out.writes.join('').match(/\x1b\]8;;(file:[^\x07]+)\x07/)![1]!;
    while (!f.out.vt.row('Полный текст')) f.wheel(false);
    assert.match(f.lines(), /Полный текст/);
    f.session.close();
    const transcript = f.out.writes.join('').split('\x1b[?1049l').at(-1)!;
    assert.ok(transcript.includes(url)); assert.match(readFileSync(fileURLToPath(url), 'utf8'), /T0080/);
    const bad = join(f.dir, 'file'); writeFileSync(bad, 'file');
    configureThinking({ dir: bad, links: true });
    const saved: string[] = [];
    setDisplaySink({ append: (record) => saved.push(renderRecord(record, false, 120, false).join('\n')), fail: () => {} });
    log.thinking('spec-author', lines('T', 80));
    assert.doesNotMatch(saved.join(''), /\x1b\]8/);
  } finally { setDisplaySink(); f.close(); }
});

test('hold/release: порядок и preview совпадают, пустое размышление — обычная строка', () => {
  const records: string[] = [];
  setDisplaySink({ append: (r) => records.push(renderRecord(r, false, 120, false).join('\n')), fail: () => {} });
  try {
    log.hold(); log.write('FIRST'); log.thinking('spec-author', ' '); log.write('LAST');
    assert.deepEqual(records, []); log.release();
    assert.match(records[0]!, /FIRST/); assert.match(records[1]!, /… размышляет/); assert.match(records[2]!, /LAST/);
  } finally { setDisplaySink(); }
});

test('одни записи дают одинаковые порядок и canonical preview в sink и потоке', () => {
  const records: Parameters<typeof renderRecord>[0][] = [];
  const printed: string[] = [];
  const original = console.log;
  configureThinking({ chars: 200, links: false, dir: null });
  try {
    setDisplaySink({ append: (record) => records.push(record), fail: () => {} });
    log.write('FIRST'); log.thinking('spec-author', lines('T', 80)); log.write('LAST');
    setDisplaySink(); console.log = (text: string) => { printed.push(text); };
    log.write('FIRST'); log.thinking('spec-author', lines('T', 80)); log.write('LAST');
    const withoutTime = (s: string) => s.replace(/\d{2}:\d{2}:\d{2}/g, 'TIME');
    assert.deepEqual(printed.map(withoutTime), records.map((r) => withoutTime(renderRecord(r, false, process.stdout.columns || 120, false).join('\n'))));
  } finally { console.log = original; setDisplaySink(); configureThinking({ chars: 300 }); }
});

test('no-mouse/env/pipe: без окна, мыши и подписок', () => {
  for (const variant of ['flag', 'env', 'pipe']) {
    const out = new FakeTerminal(), input = new FakeInput();
    if (variant === 'pipe') out.isTTY = false;
    const store = new RunStore(mkdtempSync(join(tmpdir(), 'fallback-')));
    const session = startTerminalSession({ out, input, store, noPanel: true, noMouse: variant === 'flag', env: variant === 'env' ? { AGENTFLOW_NO_MOUSE: '1' } : {}, panel: { runId: 'r', change: 'c', roles: 5, launches: 0 } });
    session.close();
    assert.doesNotMatch(out.writes.join(''), /1049|1000|1006/);
    assert.equal(input.listenerCount('data'), 0); assert.equal(input.raw, false);
    assert.equal(readdirSync(store.runDir).length, 0);
  }
});

test('сбой append: окно закрыто, прежний transcript и текущая запись выведены по одному разу', (t) => {
  const f = fixture();
  try {
    log.write('BEFORE-FAILURE');
    t.mock.method(DisplayJournal.prototype, 'append', () => { throw new Error('DISK-FAILED'); });
    log.write('CURRENT-RECORD'); log.write('NEXT-RECORD');
    assert.equal(f.input.raw, false); assert.equal(f.out.vt.alternate, false);
    const transcript = f.out.writes.join('').split('\x1b[?1049l').at(-1)!;
    for (const text of ['BEFORE-FAILURE', 'CURRENT-RECORD', 'NEXT-RECORD']) assert.equal(transcript.match(new RegExp(text, 'g'))?.length, 1);
    assert.match(transcript, /DISK-FAILED/);
  } finally { f.close(); }
});

test('нет журнала: текущая строка остаётся в потоковом выводе', (t) => {
  const store = new RunStore(mkdtempSync(join(tmpdir(), 'no-journal-')));
  t.mock.method(store, 'createDisplayJournal', () => { throw new Error('NO-JOURNAL'); });
  const out = new FakeTerminal(), input = new FakeInput();
  const session = startTerminalSession({ store, input, out, panel: { runId: 'r', change: 'c', roles: 5, launches: 0 } });
  log.write('CURRENT'); session.close();
  assert.match(out.writes.join(''), /NO-JOURNAL[\s\S]*CURRENT/);
  assert.equal(input.listenerCount('data'), 0);
});

test('закрытие во время меню сохраняет поступившие записи и снимает удержание', () => {
  const f = fixture();
  try {
    log.write('FIRST'); f.session.pause(); log.write('WHILE-MENU');
    f.session.close();
    const transcript = f.out.writes.join('').split('\x1b[?1049l').at(-1)!;
    assert.match(transcript, /FIRST[\s\S]*WHILE-MENU/);
    const records: string[] = [];
    setDisplaySink({ append: (r) => records.push(renderRecord(r, false, 120, false).join('\n')), fail: () => {} });
    log.write('UNHELD'); assert.deepEqual(records, ['UNHELD']);
  } finally { setDisplaySink(); f.close(); }
});

for (const mode of ['success', 'blocked', 'throw', 'SIGINT', 'SIGTERM']) {
  test(`жизненный цикл в дочернем процессе: ${mode}`, async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tools/agentflow/test-support/session-child.ts', mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const ready = new Promise<void>((resolve) => child.stdout.on('data', (chunk: Buffer) => { output += String(chunk); if (output.includes('READY')) resolve(); }));
    child.stderr.resume();
    if (mode === 'SIGINT' || mode === 'SIGTERM') { await ready; child.kill(mode); }
    const [code] = await once(child, 'exit');
    assert.equal(code, mode === 'SIGINT' ? 130 : mode === 'SIGTERM' ? 143 : mode === 'throw' ? 1 : 0);
    const result = JSON.parse(output.trim().split('\n').at(-1)!) as { raw: boolean; reporting: boolean; alternate: boolean; lines: string[]; transcript: string; listeners: number; resize: number };
    assert.deepEqual([result.raw, result.reporting, result.alternate, result.listeners, result.resize], [false, false, false, 0, 0]);
    assert.match(result.lines.join('\n'), /BEFORE-RUN/);
    assert.equal(result.transcript.match(/CHILD-LOG/g)?.length, 1);
  });
}
