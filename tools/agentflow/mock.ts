// Mock-раннер ролей (--mock): проходит весь конвейер без моделей на заготовленной
// задаче slugify. Нужен, чтобы проверить контроллер, петли, ACL, гейты и git до подключения
// корпоративного CLI. Запись файлов идёт через тот же ACL, что и у настоящих ролей.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { c, log } from './log.ts';
import { decideAcl, describeTask, newTracker, spawnTools, syncPanel, Watchdog, type RoleCall, type RoleResult, type RoleRuntime, type TaskMeta } from './roles.ts';
import type { SessionTracker } from './session-tracker.ts';
import { KIT_BIN } from './config.ts';
import { gateEnv } from './policy.ts';
import { exec } from './util.ts';

const ARTIFACTS: Record<string, Record<string, string>> = {
  proposal: {
    'proposal.md': `# Proposal

## Why

Ссылкам и именам файлов нужны URL-совместимые идентификаторы из произвольных строк.

## What Changes

- Новая функция \`slugify(text)\` в \`src/strings.js\` и её реэкспорт из \`src/index.js\`.
- Вне scope: транслитерация кириллицы и настраиваемый разделитель.

## Capabilities

### New Capabilities

- \`text-slug\`: преобразование строк в slug для URL

### Modified Capabilities

## Impact

\`src/strings.js\`, \`src/index.js\`, \`test/\`.
`,
  },
  specs: {
    'specs/text-slug/spec.md': `# Spec Delta

## Purpose

Преобразование произвольных строк в URL-совместимые идентификаторы для ссылок и имён файлов.

## ADDED Requirements

### Requirement: Slug из произвольной строки
Функция \`slugify(text)\` SHALL возвращать строку из латинских букв нижнего регистра и цифр, где слова разделены одним дефисом.

#### Scenario: Пробелы и регистр
- **WHEN** вызывается \`slugify("Hello World")\`
- **THEN** результат равен \`"hello-world"\`

#### Scenario: Только нелатинские символы
- **WHEN** вызывается \`slugify("!!!")\`
- **THEN** результат равен \`""\`

### Requirement: Отказ на нестроковый вход
Функция \`slugify\` SHALL выбрасывать \`TypeError\`, если аргумент не строка.

#### Scenario: Число на входе
- **WHEN** вызывается \`slugify(42)\`
- **THEN** выбрасывается \`TypeError\`
`,
  },
  design: {
    'design.md': `# Design

## Context

Библиотека — ESM-модули в \`src/\`, см. proposal.md.

## Goals / Non-Goals

**Goals:** публичная функция \`slugify\` из \`src/index.js\`.

**Non-Goals:** транслитерация.

## Decisions

- Реализация в \`src/strings.js\` рядом с \`capitalize\`: тот же модуль строковых утилит. Альтернатива — отдельный модуль; отклонена, функция одна.
- Нелатинские символы считаются разделителями и отбрасываются регулярным выражением \`/[^a-z0-9]+/g\`.

## Risks / Trade-offs

- [Кириллица теряется] → явно вне scope в proposal.
`,
  },
  'test-plan': {
    'test-plan.md': `# Test Plan

## Scope

text-slug: «Slug из произвольной строки», «Отказ на нестроковый вход».

## Environment

\`import { slugify } from '../src/index.js'\`.

## Scenarios

| Requirement | Scenario | Steps (inputs) | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| Slug из произвольной строки | Пробелы и регистр | \`slugify("Hello World")\` | \`"hello-world"\` | e2e/evidence/e2e-run.txt |
| Slug из произвольной строки | Только нелатинские символы | \`slugify("!!!")\` | \`""\` | e2e/evidence/e2e-run.txt |
| Отказ на нестроковый вход | Число на входе | \`slugify(42)\` | \`TypeError\` | e2e/evidence/e2e-run.txt |

## Evidence

Вывод \`run.sh e2e\` в e2e/evidence/e2e-run.txt.

## Manual check

1. \`node -e "import('./src/index.js').then(m => console.log(m.slugify('Hello World')))"\` печатает \`hello-world\`.
`,
  },
  tasks: {
    'tasks.md': `# Tasks

## 1. Функция slugify

- [ ] 1.1 Добавить \`slugify\` в src/strings.js с unit-тестами в test/slugify.test.js; проверка: run.sh unit зелёный

## 2. Публичный экспорт

- [ ] 2.1 Реэкспортировать \`slugify\` из src/index.js; проверка: unit-тест импортирует slugify из src/index.js
`,
  },
};

const SLUGIFY = `
/**
 * Превращает строку в slug для URL: латиница нижнего регистра и цифры через дефис.
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  if (typeof text !== 'string') {
    throw new TypeError('slugify: ожидается строка');
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

/** Сколько размышлений присылает сессия под think-long:<роль>, по одному в секунду. */
const THINK_LONG = 30;

/** Размышление mock-роли: фиксированный текст в несколько абзацев, чтобы раскрытие по клику было видно. */
function mockThinking(role: string, meta: TaskMeta): string {
  return [
    `Я ${role}, задача: ${describeTask(meta) || meta.kind}. Сначала перечитаю промпт контроллера целиком: что от меня ждут, какие файлы мне разрешено менять и в каком формате вернуть ответ. Ошибиться в формате дороже, чем потратить лишний ход на чтение.`,
    'Intent простой — функция slugify(text): строка в нижнем регистре, всё, что не латиница и не цифры, превращается в один дефис, а дефисы по краям убираются. Неочевидные места — кириллица и пустая строка. По примерам intent кириллица отбрасывается, а пустая строка даёт пустую строку, а не ошибку.',
    'Что может пойти не так: несколько разделителей подряд («a  --  b») должны дать один дефис; строка из одних разделителей — пустую строку; не строка на входе — TypeError с понятным сообщением. Это стоит держать в голове и при ревью, и при тестах, и при финальной проверке трассируемости.',
    'План: прочитать нужные файлы, сделать свою часть, сверить результат с требованиями REQ-* и сценариями SCN-*, затем вернуть ответ строго по контракту. Если что-то в intent противоречит спеке, лучше спросить, чем угадывать: решение человека дешевле лишнего раунда исправлений, а раунд исправлений дешевле ошибки, найденной на приёмке.',
    'Отдельно про ACL: писать можно только в разрешённые пути, shell — только agentflow-gate с операцией из policy. Если вызов отклонят, причину и разрешённое контроллер вернёт в ответе инструмента; повторять тот же вызов бессмысленно, лучше выбрать разрешённый путь или сказать, чего не хватает.',
  ].join('\n\n');
}

function json(v: unknown): string {
  return 'Готово.\n```json\n' + JSON.stringify(v, null, 2) + '\n```';
}

export async function runMock(rt: RoleRuntime, call: RoleCall): Promise<RoleResult> {
  const { role, meta } = call;
  const session = call.resume ?? randomUUID();
  log.spawn(role.name, { model: `${role.model} (mock)`, effort: role.effort, session, resume: !!call.resume, tools: spawnTools(rt.policy, role, call.readOnly), target: describeTask(meta) });
  log.role(role.name, c.gray('сессия открыта · mock'));
  const tracker = newTracker(rt, role.name);
  const abort = new AbortController();
  const watch = new Watchdog(rt, call, tracker, abort);
  let res: RoleResult | undefined;
  try {
    // Точка stall:<роль>: сессия молчит, пока сторож её не прервёт. Процесс держит таймер —
    // у настоящей сессии его держит дочерний CLI, а сторож свой таймер не держит.
    if (meta.silent) {
      const keep = setInterval(() => {}, 1000);
      await new Promise((done) => abort.signal.addEventListener('abort', done, { once: true }));
      clearInterval(keep);
    } else res = await mockSession(rt, call, session, tracker);
  } finally {
    await watch.stop();
    log.roleEnd(role.name, !!res && !watch.outcome);
  }
  if (watch.outcome || !res) {
    const denials = tracker.summary();
    log.denials(role.name, denials.groups);
    const error = watch.outcome?.message ?? 'сессия прервана';
    return { ok: false, sessionId: session, text: '', error, turns: 0, seconds: 0, models: [], denials: denials.total, ...(watch.outcome ? { intervention: watch.outcome } : {}) };
  }
  return res;
}

async function mockSession(rt: RoleRuntime, call: RoleCall, session: string, tracker: SessionTracker): Promise<RoleResult> {
  const { role, meta } = call;
  const acl = (tool: string, input: Record<string, unknown>) => {
    const d = decideAcl(rt, role.name, !!call.readOnly, tool, input);
    log.acl(role.name, tool, d);
    tracker.event();
    tracker.acl(tool, input, d);
    syncPanel(tracker);
    return d;
  };
  // Те же сообщения потока, что у настоящей сессии, чтобы `agentflow agents` работал и в mock.
  rt.ledger({ ev: 'sdk', step: call.label, role: role.name, msg: { type: 'system', subtype: 'init', session_id: session, model: `${role.model} (mock)`, tools: spawnTools(rt.policy, role, call.readOnly), permission_mode: 'default' } });

  // Размышление, как у модели в thinking mode: строка в логе и блок thinking в events.jsonl.
  const think = (text: string) => {
    rt.ledger({ ev: 'sdk', step: call.label, role: role.name, msg: { type: 'assistant', session_id: session, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } } });
    log.thinking(role.name, text);
    tracker.event();
    syncPanel(tracker);
  };
  if (meta.thinkLong) {
    for (let i = 1; i <= THINK_LONG; i++) {
      think(`Шаг ${i}/${THINK_LONG}. ${mockThinking(role.name, meta)}`);
      await new Promise((done) => setTimeout(done, 1000));
    }
  } else think(mockThinking(role.name, meta));

  const write = (rel: string, content: string) => {
    log.toolUse(role.name, 'write_file', rel);
    if (!acl('write_file', { file_path: rel }).ok) return;
    const abs = join(rt.worktree, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const read = (rel: string) => {
    log.toolUse(role.name, 'read_file', rel);
    tracker.event();
    return readFileSync(join(rt.worktree, rel), 'utf8');
  };
  const pass = (target: string, extra: Record<string, unknown> = {}) => ({
    status: 'PASS',
    role: role.name,
    target,
    snapshotId: meta.snapshotId,
    round: meta.round ?? 1,
    checks: (meta.checks ?? []).map((id) => ({ id, result: 'PASS', note: 'mock' })),
    specCompliance: null,
    codeQuality: null,
    findings: [],
    traceability: [],
    missingContext: [],
    ...extra,
  });

  let text: string;
  switch (meta.kind) {
    case 'clarify':
      text = json({
        questions: [
          {
            question: 'Транслитерировать ли кириллицу или отбрасывать её?',
            why: 'меняет требования к slugify',
            options: [
              { label: 'Отбрасывать', description: 'как в примерах intent, без зависимостей' },
              { label: 'Транслитерировать', description: 'нужна таблица транслитерации' },
            ],
            recommended: 0,
            rationale: 'в intent пример «Привет, Code» → «code»',
          },
        ],
      });
      break;
    case 'discuss': {
      // Варианты те же, у рекомендуемого уточнено описание: проверяется путь обновления вариантов,
      // а выбор автопилота не меняется.
      const d = meta.discuss ?? { id: '?', options: [], recommended: 0 };
      const message = call.prompt.split('## Новая реплика человека')[1]?.split('## Как отвечать')[0]?.trim() ?? '';
      text = json({
        answer: `mock: на реплику «${message}» — варианты отличаются последствиями из их описаний; рекомендую «${d.options[d.recommended]?.label ?? '?'}».`,
        options: d.options.map((o, i) => (i === d.recommended ? { ...o, description: `${o.description ?? o.label} (уточнено в обсуждении)` } : o)),
        recommended: d.recommended,
      });
      break;
    }
    case 'author': {
      for (const [file, content] of Object.entries(ARTIFACTS[meta.artifact ?? ''] ?? {})) write(`${meta.changeDir}/${file}`, content);
      const responses = (call.prompt.match(/^- ([A-Z]+-\d+) \[/gm) ?? []).map((m) => ({ id: m.slice(2, -2), resolution: 'fixed', evidence: 'mock: перечитано по рубрике' }));
      // Один вопрос на первом раунде specs — чтобы был виден диалог на твоём ревью артефакта.
      const questions =
        meta.artifact === 'specs' && meta.round === 1
          ? [
              {
                question: 'Что возвращать, если после очистки строка пустая?',
                why: 'сценарий «Только нелатинские символы»',
                options: [
                  { label: 'Пустую строку', description: 'совпадает с примером intent "!!!" → ""' },
                  { label: 'Бросать RangeError', description: 'явная ошибка вызывающему коду' },
                ],
                recommended: 0,
                rationale: 'так в примере intent',
              },
            ]
          : [];
      text = json({ artifact: meta.artifact, files: Object.keys(ARTIFACTS[meta.artifact ?? ''] ?? {}), responses, questions });
      break;
    }
    case 'spec-review':
    case 'holistic':
      read(`${meta.changeDir}/proposal.md`);
      text = json(pass(meta.target ?? ''));
      break;
    case 'implement': {
      const strings = read('src/strings.js');
      if (meta.batchId === '1' && !strings.includes('slugify')) {
        write('src/strings.js', strings + SLUGIFY);
        write(
          'test/slugify.test.js',
          "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/strings.js';\n\n" +
            "test('slugify: пробелы и регистр', () => {\n  assert.equal(slugify('Hello World'), 'hello-world');\n});\n\n" +
            "test('slugify: нестроковый вход', () => {\n  assert.throws(() => slugify(42), TypeError);\n});\n",
        );
      }
      if (meta.batchId === '2' && !read('src/index.js').includes('slugify')) {
        write('src/index.js', "export { capitalize, slugify } from './strings.js';\n");
        write(
          'test/index.test.js',
          "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/index.js';\n\n" +
            "test('slugify реэкспортируется из index', () => {\n  assert.equal(typeof slugify, 'function');\n});\n",
        );
      }
      log.toolUse(role.name, 'run_shell_command', 'agentflow-gate lint');
      acl('run_shell_command', { command: 'agentflow-gate lint' });
      text = json({ status: 'DONE', tasks: [], responses: [], specIssue: null });
      break;
    }
    case 'code-review':
      text = json(pass(meta.target ?? '', { specCompliance: { result: 'PASS', summary: 'mock' }, codeQuality: { result: 'PASS', summary: 'mock' } }));
      break;
    case 'acceptance': {
      const reqs = meta.requirements ?? [];
      const body = reqs
        .flatMap((r) => r.scenarios.map((s) => ({ r, s })))
        .map(({ s }) => {
          const assertion = s.name.includes('Число') ? 'assert.throws(() => slugify(42), TypeError);' : s.name.includes('нелатин') ? "assert.equal(slugify('!!!'), '');" : "assert.equal(slugify('Hello World'), 'hello-world');";
          return `test('${s.id} ${s.name}', () => {\n  ${assertion}\n});\n`;
        })
        .join('\n');
      write('e2e/text-slug.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/index.js';\n\n" + body);
      log.toolUse(role.name, 'run_shell_command', 'agentflow-gate e2e');
      const r = await exec('bash', [`${KIT_BIN}/agentflow-gate`, 'e2e'], { cwd: rt.worktree, env: { ...process.env, ...gateEnv(rt.policy) } });
      tracker.event();
      const scenarios = reqs.flatMap((rq) => rq.scenarios.map((s) => ({ rq, s })));
      const result = r.code === 0 ? 'PASS' : 'FAIL';
      text = json({
        ...pass('acceptance'),
        status: r.code === 0 ? 'PASS' : 'REVISE',
        checks: scenarios.map(({ s }) => ({ id: s.id, result, note: 'e2e/evidence/e2e-run.txt' })),
        traceability: scenarios.map(({ rq, s }) => ({ requirementId: rq.id, scenarioId: s.id, tests: ['e2e/text-slug.test.js'], evidence: 'e2e/evidence/e2e-run.txt', result })),
      });
      break;
    }
    case 'final-review':
      text = json(
        pass('final', {
          specCompliance: { result: 'PASS', summary: 'mock' },
          codeQuality: { result: 'PASS', summary: 'mock' },
          traceability: (meta.requirements ?? []).map((r) => ({ requirementId: r.id, code: ['src/strings.js'], tests: ['test/slugify.test.js', 'e2e/text-slug.test.js'], evidence: 'e2e/evidence/e2e-run.txt', result: 'PASS' })),
        }),
      );
      break;
    default:
      text = json({});
  }
  log.role(role.name, '«' + text.split('\n')[0] + ' …»');
  rt.ledger({ ev: 'sdk', step: call.label, role: role.name, msg: { type: 'assistant', session_id: session, message: { model: `${role.model} (mock)` } } });
  rt.ledger({ ev: 'sdk', step: call.label, role: role.name, msg: { type: 'result', session_id: session, num_turns: 1 } });
  const denials = tracker.summary();
  log.roleDone(role.name, { turns: 1, seconds: 0, models: [`${role.model} (mock)`], denials: denials.total, groups: denials.groups });
  return { ok: true, sessionId: session, text, turns: 1, seconds: 0, models: [`${role.model} (mock)`], denials: denials.total };
}
