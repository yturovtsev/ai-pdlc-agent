#!/usr/bin/env node
// Глобальная команда agentflow (npm link в kit): запускает контроллер kit в текущем репозитории.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const [cmd, ...rest] = process.argv.slice(2);
const script = cmd === 'smoke' ? 'smoke.ts' : 'controller.ts';
const args = cmd === 'smoke' ? rest : process.argv.slice(2);
// Ctrl+C получает вся группа процессов: обёртка ждёт контроллер, чтобы он успел вернуть терминал
// (панель статуса), и выходит с его кодом, а не умирает первой.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {});
const r = spawnSync(join(kit, 'node_modules/.bin/tsx'), [join(kit, 'tools/agentflow', script), ...args], { stdio: 'inherit' });
const signals = { SIGINT: 2, SIGTERM: 15 };
process.exit(r.status ?? (r.signal && signals[r.signal] ? 128 + signals[r.signal] : 1));
