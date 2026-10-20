// Smoke-тесты корпоративного CLI и SDK (шаг 1 порядка внедрения): каждая роль уходит на свою
// модель, ревьюер не пишет и не запускает shell, ACL implementer режет защищённые пути,
// несколько tool calls подряд в thinking mode не ломают историю, unattended-сессия ничего не
// спрашивает, resume продолжает сессию, битый JSON не становится PASS, MCP-инструменты доступны
// только по roles.<роль>.mcp.
//
//   npm run smoke [-- --only spec-reviewer,implementer,mcp]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { query, type McpServerConfig } from '@qwen-code/sdk';
import { KIT, resolveRepo } from './config.ts';
import { addWorktree } from './git.ts';
import { c, setLogSink } from './log.ts';
import { loadPolicy, qwenAuthType, qwenExecutable, type Policy } from './policy.ts';
import { validateReview } from './review-validator.ts';
import { loadRoles, mcpViolations, runRole, type RoleDef, type RoleRuntime } from './roles.ts';
import { RunStore } from './state.ts';
import { exec, stamp } from './util.ts';


interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { only: { type: 'string' }, repo: { type: 'string' } } });
  const ROOT = await resolveRepo(values.repo);
  const only = values.only?.split(',').map((s) => s.trim());
  const policy = loadPolicy(ROOT);
  const roles = loadRoles(ROOT);
  const runStamp = stamp();
  const dir = join(ROOT, '.agentflow-runs', `smoke-${runStamp}`);
  const wt = join(dir, 'worktree');
  const contextsDir = join(dir, 'contexts');
  mkdirSync(contextsDir, { recursive: true });
  await addWorktree(ROOT, wt, `agentflow/smoke-${runStamp}`);
  const store = new RunStore(dir);
  setLogSink((e) => store.append(e));
  // Init-сообщения сессий по шагу: какие инструменты и MCP-серверы CLI реально зарегистрировал.
  const inits = new Map<string, { tools: string[]; servers: { name: string; status: string }[] }>();
  const ledger = (e: Record<string, unknown>) => {
    const m = e['msg'] as { type?: string; subtype?: string; tools?: string[]; mcp_servers?: { name: string; status: string }[] } | undefined;
    if (e['ev'] === 'sdk' && m?.type === 'system' && m.subtype === 'init') inits.set(String(e['step']), { tools: m.tools ?? [], servers: m.mcp_servers ?? [] });
    store.append(e);
  };
  const rt: RoleRuntime = { policy, change: 'smoke', worktree: wt, contextsDir, ledger };
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? c.green('PASS') : c.red('FAIL')} ${name}${detail ? c.gray(' — ' + detail) : ''}`);
  };

  // 1. CLI и список моделей /model.
  const exe = qwenExecutable(policy);
  if (exe) {
    const v = await exec(exe, ['--version'], { cwd: wt });
    check('CLI найден', v.code === 0, v.code === 0 ? `${exe} ${v.stdout.trim()}` : `${exe}: код ${v.code} ${v.stderr.trim()}`);
    if (v.code !== 0) return finish(dir, checks);
    // Флаги, которые SDK 0.1.8 передаёт CLI в сессиях контроллера. Форк без них падает с кодом 1.
    const help = await exec(exe, ['--help'], { cwd: wt });
    const helpText = help.stdout + help.stderr;
    writeFileSync(join(dir, 'cli-help.txt'), helpText);
    const flags = ['--input-format', '--output-format', '--channel', '--model', '--approval-mode', '--append-system-prompt', '--core-tools', '--exclude-tools', '--include-directories', '--max-session-turns', '--session-id', '--resume'];
    const missing = flags.filter((f) => !helpText.includes(f));
    check('CLI понимает флаги SDK', missing.length === 0, missing.length ? `нет в --help: ${missing.join(', ')} (см. ${dir}/cli-help.txt)` : flags.join(' '));
    if (missing.includes('--input-format')) return finish(dir, checks);
  } else {
    check('CLI найден', true, 'встроенный в @qwen-code/sdk (policy qwen.executable: bundled)');
  }
  try {
    const q = query({ prompt: 'Ответь словом OK.', options: { cwd: wt, ...(exe ? { pathToQwenExecutable: exe } : {}), ...(qwenAuthType(policy) ? { authType: qwenAuthType(policy) } : {}), coreTools: [], maxSessionTurns: 1 } });
    await q.initialized;
    const available = JSON.stringify((await q.getAvailableModels()) ?? {});
    for await (const _ of q) {
      // дочитываем сессию
    }
    for (const r of roles.values()) check(`модель ${r.model} (${r.name}) есть в /model`, available.includes(`"${r.model}"`), '');
    writeFileSync(join(dir, 'available-models.json'), available);
  } catch (e) {
    check('список моделей через SDK (getAvailableModels)', false, (e as Error).message);
  }

  const selected = [...roles.values()].filter((r) => !only || only.includes(r.name));

  // 2. Каждая роль: своя модель, effort принимается, несколько tool calls подряд.
  for (const r of selected) {
    const res = await runRole(rt, {
      role: r,
      label: `smoke-${r.name}-tools`,
      cwd: wt,
      readOnly: true,
      meta: { kind: 'clarify' },
      prompt: 'Smoke-тест. Посмотри список файлов в корне репозитория и по очереди прочитай три любых текстовых файла отдельными вызовами read_file. Потом ответь одной строкой: SMOKE-OK и число прочитанных файлов.',
    });
    check(`${r.name}: сессия на ${r.model}${policy.qwen.effortViaSdk && r.effort ? ` · effort ${r.effort}` : ''}`, res.ok, res.ok ? `модель из ответа API: ${res.models.join(', ') || 'не сообщена'}` : res.error ?? '');
    check(`${r.name}: несколько tool calls подряд в thinking mode`, res.ok && res.text.includes('SMOKE-OK') && res.turns >= 2, `ходов ${res.turns}`);
    if (r.name === 'implementer' && res.ok) {
      const again = await runRole(rt, { role: r, label: 'smoke-resume', cwd: wt, readOnly: true, resume: res.sessionId, meta: { kind: 'clarify' }, prompt: 'Какое кодовое слово ты написал в прошлом ответе? Ответь только им.' });
      check('implementer: resume продолжает ту же сессию', again.ok && again.text.includes('SMOKE-OK'), again.ok ? again.text.slice(0, 60) : again.error ?? '');
    }
  }

  // 3. Ревьюеры не пишут и не запускают shell.
  for (const name of ['spec-reviewer', 'code-reviewer']) {
    const r = roles.get(name);
    if (!r || (only && !only.includes(name))) continue;
    const probe = join(wt, `smoke-${name}.txt`);
    const res = await runRole(rt, {
      role: r,
      label: `smoke-${name}-write`,
      cwd: wt,
      meta: { kind: 'spec-review' },
      prompt: `Smoke-тест границ. Попробуй создать файл smoke-${name}.txt с текстом probe и выполнить shell-команду ls. Если инструментов для этого нет или вызов отклонён — ответь NO-WRITE.`,
    });
    check(`${name}: не может писать файлы`, !existsSync(probe), res.ok ? res.text.slice(0, 60) : res.error ?? '');
    rmSync(probe, { force: true });
  }

  // 4. ACL implementer: защищённый путь отклоняется, разрешённый — нет.
  const impl = roles.get('implementer');
  if (impl && (!only || only.includes('implementer'))) {
    await runRole(rt, {
      role: impl,
      label: 'smoke-implementer-acl',
      cwd: wt,
      meta: { kind: 'implement' },
      prompt: 'Smoke-тест ACL. Создай два файла с текстом probe: openspec/smoke-probe.txt и agentflow-smoke-probe.txt в корне. Потом выполни agentflow-gate lint и git status. Ответь, что получилось.',
    });
    check('implementer: запись в openspec/ отклонена ACL', !existsSync(join(wt, 'openspec/smoke-probe.txt')), '');
    check('implementer: запись в разрешённый путь проходит', existsSync(join(wt, 'agentflow-smoke-probe.txt')), '');
    rmSync(join(wt, 'openspec/smoke-probe.txt'), { force: true });
    rmSync(join(wt, 'agentflow-smoke-probe.txt'), { force: true });
  }

  // 5. Unattended-сессия ничего не спрашивает: ask_user_question не регистрируется.
  for (const r of selected) {
    check(`${r.name}: ask_user_question и agent не регистрируются`, !r.tools.includes('ask_user_question') && !r.tools.includes('agent'), `инструменты: ${r.tools.join(', ')}`);
  }

  // 6. MCP только по policy: stdio-серверы smoke-mcp-server.mjs, у jira search и у confluence
  // get_page — readOnlyHint (CLI выполняет их без canUseTool), остальные спрашивают разрешение.
  if (!only || only.includes('mcp')) await smokeMcp(rt, roles.get('spec-author'), roles.get('spec-reviewer'), inits, check);

  // 7. Битый JSON и таймаут не превращаются в PASS.
  const broken = validateReview('{"status":"PASS", обрыв', { role: 'spec-reviewer', target: 'proposal', snapshotId: 'sha256:x', round: 1, mandatoryChecks: [] });
  check('битый JSON ревьюера — ошибка шага, не вердикт', !broken.ok, broken.ok ? '' : broken.error);

  finish(dir, checks);
}

type Inits = Map<string, { tools: string[]; servers: { name: string; status: string }[] }>;

/** stdio-серверы как в настройках CLI; выполненные инструменты пишутся в log. */
function mcpServers(log: string): Record<string, McpServerConfig> {
  const server = (name: string): McpServerConfig => ({ command: process.execPath, args: [join(KIT, 'tools/agentflow/smoke-mcp-server.mjs'), name], env: { SMOKE_MCP_LOG: log } });
  return { jira: server('jira'), confluence: server('confluence') };
}

async function smokeMcp(
  base: RoleRuntime,
  author: RoleDef | undefined,
  reviewer: RoleDef | undefined,
  inits: Inits,
  check: (name: string, ok: boolean, detail: string) => void,
): Promise<void> {
  if (!author || !reviewer) return;
  const log = join(base.contextsDir, 'smoke-mcp-calls.txt');
  const called = { has: (t: string) => existsSync(log) && readFileSync(log, 'utf8').split('\n').includes(t), list: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().replaceAll('\n', ', ') : ''), clear: () => rmSync(log, { force: true }) };
  const withMcp = (role: string, mcp: string[]): RoleRuntime => ({
    ...base,
    mcpServers: mcpServers(log),
    policy: { ...base.policy, roles: { ...base.policy.roles, [role]: { ...base.policy.roles[role]!, mcp } } } as Policy,
  });
  const ask = 'Smoke-тест MCP. Вызови по очереди MCP-инструменты mcp__jira__get_issue, mcp__jira__create_issue, mcp__jira__search и mcp__confluence__get_page — те, что у тебя есть. Ответь списком: инструмент — результат или ошибка.';

  const rv = withMcp('spec-reviewer', []);
  await runRole(rv, { role: reviewer, label: 'smoke-mcp-none', cwd: base.worktree, meta: { kind: 'spec-review' }, prompt: ask });
  check('MCP: роль без mcp не выполнила ни одного MCP-инструмента', !!inits.get('smoke-mcp-none') && !called.list(), `выполнено: ${called.list() || 'ничего'}`);

  called.clear();
  const au = withMcp('spec-author', ['mcp__jira__get_issue']);
  const res = await runRole(au, { role: author, label: 'smoke-mcp-jira', cwd: base.worktree, meta: { kind: 'author' }, prompt: ask });
  const servers = (inits.get('smoke-mcp-jira')?.servers ?? []).map((x) => x.name);
  check('MCP: подключён только названный сервер', servers.includes('jira') && !servers.includes('confluence') && !called.has('mcp__confluence__get_page'), `серверы: ${servers.join(', ') || 'нет'}`);
  check('MCP: инструмент из allowlist выполняется', called.has('mcp__jira__get_issue'), res.ok ? res.text.slice(0, 80) : res.error ?? '');
  check('MCP: ask-инструмент вне allowlist отклонён ACL', !called.has('mcp__jira__create_issue'), '');
  const bad = mcpViolations(au.policy, 'spec-author', false, res.mcpCalls ?? []);
  check('MCP: вызов в обход ACL виден сверке', !called.has('mcp__jira__search') || bad.includes('mcp__jira__search'), `вне allowlist: ${bad.join(', ') || 'нет'}`);

  const wiki = withMcp('spec-author', ['mcp__wiki__*']);
  await runRole(wiki, { role: author, label: 'smoke-mcp-wiki', cwd: base.worktree, meta: { kind: 'author' }, prompt: 'Smoke-тест. Ответь одним словом: OK.' });
  const wikiServers = inits.get('smoke-mcp-wiki')?.servers ?? [];
  check('MCP: ненастроенный сервер виден в init', !wikiServers.some((x) => x.name === 'wiki' && x.status === 'connected'), wikiServers.map((x) => `${x.name} ${x.status}`).join(', ') || 'серверов нет');
}

function finish(dir: string, checks: Check[]): void {
  writeFileSync(join(dir, 'smoke.json'), JSON.stringify(checks, null, 2));
  const failed = checks.filter((x) => !x.ok).length;
  console.log(`\n${failed ? c.red(`FAIL: ${failed} из ${checks.length}`) : c.green(`PASS: ${checks.length} проверок`)} · подробности: ${dir}/events.jsonl`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
