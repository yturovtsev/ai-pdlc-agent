# agent-pdlc — контекст для агента

Kit конвейера spec-driven разработки на Qwen Code (корпоративный CLI — gigacode).
Детерминированный контроллер на TypeScript (`tools/agentflow/`) ведёт change через OpenSpec и
запускает пять ролей отдельными сессиями `@qwen-code/sdk@0.1.8`. Роли только предлагают
артефакты, код и вердикты; переходы, гейты, git и решения о прохождении принимает код.
Пользовательская документация — `README.md`, поведение — `openspec/specs/`.
Исходный дизайн: Claude Doc «Конвейер spec-driven разработки на Qwen Code — финальная конфигурация»
(https://claude.ai/artifact/B8DThSwNP1gabkXWe49Map). Отличия от него — README, раздел 7.

## Карта

| Путь | Что |
| --- | --- |
| `tools/agentflow/controller.ts` | этапы `STAGES`, петли (`artifactLoop`, `holisticLoop`, `batchLoop`, `stageFinal`), диалоги исчерпания, CLI (`run/resume/status/agents/changes/init`) |
| `roles.ts` | роли из файлов, сессия SDK на вызов (`runRole`), ACL `decideAcl` (категория, подсказка, разрешённое), сторож `Watchdog` |
| `session-tracker.ts` | состояние сессии: текущий шаг, простой, вложенные субагенты, отказы ACL, серия, сводка |
| `intervention.ts` | вмешательство при простое/серии ACL: диагноз, рекомендация, промпт повтора (чистые функции) |
| `context-builder.ts` | промпты ролей, индекс требований `REQ-*/SCN-*`, батчи из задач OpenSpec |
| `review-validator.ts` | контракт ответа ревьюера и правила принятия (`decide`) |
| `human.ts` | меню стрелками: рекомендация `★` + обоснование; `--auto-approve` выбирает рекомендацию |
| `status-panel.ts` | панель статуса внизу терминала в три строки (субагент и активные, текущий шаг и с какого времени, контекст); пополняется хуками `log.ts` |
| `config.ts`, `policy.ts` | kit vs целевой репозиторий, слои настроек, `gateEnv` |
| `openspec.ts`, `git.ts`, `gates.ts`, `snapshot.ts`, `state.ts` | детерминированные узлы |
| `mock.ts`, `inject.ts`, `smoke.ts`, `agents.ts`, `report.ts` | mock-роли, fault injection, smoke CLI, список сессий, ACCEPTANCE.md |
| `bin/agentflow.mjs`, `bin/agentflow-gate` | глобальная команда (`npm link`); единственная shell-команда ролей |
| `.qwen/agents/*.md` | 5 ролей: model (id из `/model`), effort (наше поле), tools, maxTurns, промпт |
| `.agentflow/policy.yaml`, `rubrics/`, `review.schema.json` | лимиты, ACL, гейты; рубрики; контракт |
| `openspec/schemas/agentflow` | схема демо: spec-driven + test-plan |
| `src/ test/ e2e/ tasks/` | демо-библиотека и тестовые intent — цель конвейера в kit |

## Команды

```bash
npm run typecheck && npm run lint && npm run test:agentflow     # всегда после правок контроллера
npm run agentflow -- run tasks/01-slugify.md --mock --auto-approve --inject all   # все петли без моделей
npm run smoke                                                    # корпоративный CLI (нужны модели)
agentflow <run|resume|status|agents|changes|init|smoke>          # в любом репозитории после npm link
```

Mock-прогон создаёт ветку и worktree и коммитит в них: гоняй его в копии kit с `git init` или на
закоммиченном дереве. Mock-роли пишут только задачу slugify демо-проекта.

## Соглашения

- TS ESM без сборки (tsx), импорты с `.ts`, `strict` + `noUncheckedIndexedAccess`.
- Тексты для человека и комментарии — по-русски; комментарий объясняет «почему», их немного.
- Вывод — только через `log.ts` (он же пишет `events.jsonl`); состояние — через `RunStore` (атомарно).
- Решение человека — только `Human.select` с `recommended` и `rationale`.
- Новая петля: `store.loop(...)` на каждый раунд; после авто-лимита — диалог, а не обрыв.
- Пути в glob policy: `{change}`, `{acceptance}` раскрывает `expandGlob`.

## Неочевидные факты (проверено)

- SDK 0.1.8: в `query()` есть `effort`, `coreTools`, `includeDirectories`, `sessionId`/`resume`, `env`;
  `--auth-type` уходит, только если задан `authType`. stderr CLI доходит до callback только при
  `logLevel: 'debug'` — без этого причина «CLI exited with code 1» теряется.
- `effort` в плоский `reasoning_effort` CLI переводит только для хостов api.deepseek.com и z.ai;
  остальным уходит `reasoning: {effort}` → переключатель `qwen.effortViaSdk`.
- gigacode держит проектные файлы в `.gigacode/` (команды `.gigacode/commands/*.md`), а не в `.qwen/`.
  Модели в нём преднастроены, авторизация не нужна; id в ролях должны совпадать с `/model`.
- Frontmatter субагента: неизвестные поля игнорируются; `model: openai:<id>` тоже валиден.
- Инструменты: `read_file grep_search glob list_directory write_file edit run_shell_command`;
  алиасы в правилах `Read Edit Write Bash`; `read_many_files` нет. CLI читает `QWEN.md` и `AGENTS.md`.
- OpenSpec 1.14: `status --json` (артефакты, `applyRequires`), `instructions <id> --json`,
  `instructions apply --json` (задачи с `sourcePath`/`line`), `new change` без `--schema` берёт
  схему из `config.yaml`; `validate --strict` падает, пока в change нет дельт specs.
- OpenSpec ищет схемы в `openspec/schemas/<имя>/schema.yaml` проекта, в `$XDG_DATA_HOME/openspec/schemas`
  и в своей сборке; `Creating change … with schema 'spec-driven'` в спиннере `new change` — всегда дефолт,
  реальная схема из config.yaml. OpenSpec 1.13 не отдаёт `sourcePath` задач. CLI выбирает `ensureSchema`.
- Сбой API в stream-json (таймаут, `terminated`, 4xx/5xx) CLI дописывает текстом `[API Error: …]` и отдаёт
  успешный `result` — ловит `apiErrorIn`. Таймаут запроса — 120 с, `QWEN_CODE_API_TIMEOUT_MS` его меняет,
  если у модели в провайдере нет своего `generationConfig.timeout`; `env` SDK сливается с `process.env`.
- Node 22.12: `node --test test/` каталог не принимает — нужен glob; `@inquirer/*` просит ≥22.13.
- `--auto-approve` + вечно красный гейт раньше зацикливался; теперь с 3-го исчерпания рекомендуется стоп.
- Панель держится областью прокрутки DECSTBM (`ESC[1;Nr`): установка и сброс области переводят курсор
  в начало экрана, поэтому вокруг них `ESC7`/`ESC8`. Ctrl+C получает вся группа процессов: обёртка
  `bin/agentflow.mjs` перехватывает SIGINT и ждёт контроллер, иначе shell получает терминал раньше, чем
  контроллер снимет область.
- MCP в CLI 0.1.8 (проверено пробником: CLI из SDK + фейковый OpenAI-эндпоинт): `coreTools` MCP не
  фильтрует; `readOnlyHint` и `trust: true` выполняются без `canUseTool`; `excludeTools: ['mcp__*']`
  отклоняет вызов до исполнения, но из init-списка не убирает; `allowedMcpServerNames` (непустой)
  отключает остальные серверы. Модели MCP приходят через `tool_search`. SDK-серверы
  (`createSdkMcpServer`) CLI считает доверенными — для проверки ACL нужен stdio-сервер.
- Init-список `tools` ≠ инструменты модели: при `coreTools: ['read_file']` модели уходят ещё `agent`,
  `ask_user_question`, `skill`, `tool_search`; `ask_user_question` проходит `canUseTool`, `agent` и
  `skill` — нет.
- `canUseTool` в SDK 0.1.8 получает имя и вход инструмента, `tool_use_id` в нём нет. `result.permission_denials`
  (`{tool_name, tool_use_id, tool_input}`) включает и отказы ACL контроллера, и отказы самого CLI
  (`excludeTools`/`denyAll`): их разделяют сопоставлением по (инструмент, аргумент).
- Сообщения вложенного субагента CLI идут в том же потоке с `parent_tool_use_id` его вызова `task`/`agent`.
- `@inquirer/prompts` 8: промпт отменяется через второй аргумент `{ signal }`, отмена — `AbortPromptError`.
- `controller.ts` при импорте запускает `main()`: всё, что нужно unit-тестам, держи в других модулях.
- Таймер сторожа `unref`: настоящую сессию держит дочерний CLI, а молчащей mock-сессии (`stall:<роль>`)
  нужен свой таймер, иначе процесс завершается с незавершённым промисом.

## Решения (почему так)

- Оркестратор — код, а не LLM: вердикт привязан к snapshot, переходы детерминированы.
- Спеку пишет spec-author, ревьюит spec-reviewer, после PASS каждый артефакт принимает человек (решение 19.10.2026).
- Лимиты раундов не жёсткие: 3 авто, дальше решает человек. Waiver — только в фазе спеки.
- Route моделей не используются: модели из `/model`, effort через SDK.
- В чужом репозитории OpenSpec берётся как есть (схема, changes, версия CLI); kit даёт только роли,
  рубрики и policy по умолчанию.
- Прогресс задач — галочками в файле задач (digest их нормализует) и в `state.json`.

## Не сделано

Команды `/opsx:*` и `/spec-*` для gigacode; `.gigacode/settings.json`; контейнер, sandbox, сетевой
allowlist; хуки и MCP-источники требований (MCP-инструменты ролям даёт `roles.<роль>.mcp`); Claude Doc не обновлён под возврат spec-author.
На gigacode конвейер запущен у пользователя после правки id моделей; все петли целиком проверены
на mock-ролях (демо kit и чужой репозиторий со схемой spec-driven).
