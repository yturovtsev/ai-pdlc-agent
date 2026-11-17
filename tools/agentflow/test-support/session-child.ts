import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureThinking, log } from '../log.ts';
import { RunStore } from '../state.ts';
import { startTerminalSession } from '../terminal-session.ts';
import { FakeInput, FakeTerminal } from './terminal.ts';

const input = new FakeInput(), out = new FakeTerminal();
const store = new RunStore(mkdtempSync(join(tmpdir(), 'session-child-')));
out.write('BEFORE-RUN\n');
configureThinking({ dir: join(store.runDir, 'thinking'), chars: 0 });
const session = startTerminalSession({ store, input, out, noPanel: process.argv.includes('no-panel'), panel: { runId: 'r', change: 'c', roles: 5, launches: 0 } });
log.write('CHILD-LOG');
log.thinking('spec-author', 'CHILD-THINKING');
process.on('exit', () => {
  const transcript = out.writes.join('').split('\x1b[?1049l').at(-1)!;
  process.stdout.write(JSON.stringify({ raw: input.raw, reporting: out.vt.reporting, alternate: out.vt.alternate, lines: [...out.vt.history, ...out.vt.lines()], transcript, listeners: input.listenerCount('data'), resize: out.listenerCount('resize') }) + '\n');
});
const mode = process.argv[2];
if (mode === 'SIGINT' || mode === 'SIGTERM') {
  process.stdout.write('READY\n');
  setInterval(() => {}, 1000);
} else {
  try {
    if (mode === 'throw') throw new Error('TEST-EXCEPTION');
    if (mode === 'blocked') log.error('BLOCKED: TEST');
  } finally { session.close(); session.close(); }
}
