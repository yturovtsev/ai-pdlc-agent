#!/usr/bin/env node
// Глобальная команда agentflow (npm link в kit): запускает контроллер kit в текущем репозитории.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const [cmd, ...rest] = process.argv.slice(2);
const script = cmd === 'smoke' ? 'smoke.ts' : 'controller.ts';
const args = cmd === 'smoke' ? rest : process.argv.slice(2);
const r = spawnSync(join(kit, 'node_modules/.bin/tsx'), [join(kit, 'tools/agentflow', script), ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
