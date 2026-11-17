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
| `autopilot.ts` | режим `--auto-until-review`: включён ли автопилот (`handover` его выключает), ещё раунд вместо waiver, несовместимость с `--auto-approve`; жёсткий лимит раундов спеки (`autopilotStep`) |
| `run-settings.ts` | настройки run: роли (обязателен spec-author; без implementer — run только со спекой), `--skip-roles`, меню с галочками (роли, автопилоты, панель, мышь, worktree), пропускаемые шаги |
| `dialogs.ts` | диалог с остановкой: хвост меню «Остановить run» и «Всё равно перейти дальше» (`askHuman`), области петель (`Scopes.passable`) и `PassLoop` |
| `human.ts` | меню стрелками: рекомендация `★` + обоснование; `--auto-approve` выбирает рекомендацию; обсуждение вопроса и решения с ролью (`Discuss`, `DecisionDiscuss`); недоступный вариант (`disabled`); ввод через `PromptIO` — в тестах сценарий |
| `status-panel.ts` | панель статуса внизу терминала в три строки (субагент и активные, текущий шаг и с какого времени, контекст); пополняется хуками `log.ts` |
| `log-view.ts` | модель истории: стабильные id записей, высоты, якорь `(id, offset)`, followTail, ограниченный кэш страниц журнала; layout не удаляет старые записи |
| `screen.ts`, `terminal-text.ts`, `mouse.ts` | кадр истории и панель, таблица попаданий по id, перенос ANSI/OSC, непрерывные колесо/клики и PageUp/PageDown/End; Ctrl+C группе |
| `terminal-session.ts` | `startTerminalSession({store, out, input, panel, noMouse?, noPanel?, env?})`: единый владелец 1049, raw, мыши, кадров, pause/resume и однократного transcript; экспорт для приёмки без импорта controller |
| `config.ts`, `policy.ts` | kit vs целевой репозиторий, слои настроек, `gateEnv` |
| `run-tree.ts` | где run меняет код: основное дерево (по умолчанию) или `--worktree`; lock дерева, правки вне change, шаги merge |
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

Mock-прогон переключает основное дерево на ветку `agentflow/<change>` и коммитит в неё (с `--worktree` —
в свой worktree): гоняй его в копии kit с `git init`, а не в самом kit. Mock-роли пишут только задачу
slugify демо-проекта.

## Соглашения

- TS ESM без сборки (tsx), импорты с `.ts`, `strict` + `noUncheckedIndexedAccess`.
- Тексты для человека и комментарии — по-русски; комментарий объясняет «почему», их немного.
- Вывод — только через `log.ts` (он же пишет `events.jsonl`); состояние — через `RunStore` (атомарно).
- Решение человека — только `Human.select` с `recommended` и `rationale`.
- Новая петля: `store.loop(...)` на каждый раунд; после авто-лимита — диалог, а не обрыв. Петля кладёт
  свою область перехода дальше (`passLoop` в контроллере) и закрывается в `onPass`; диалог с
  «Остановить run» — через `ask` (`askHuman`), обсуждение решения — через `talk`.
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
- В режиме мыши `terminal-session.ts` владеет альтернативным экраном 1049; `screen.ts` рисует весь
  кадр с панелью, без DECSTBM и DSR. Потоковый режим (`--no-mouse`, env, pipe) сохраняется; только
  потоковая панель использует DECSTBM с ESC7/ESC8. Обёртка `bin/agentflow.mjs` ждёт контроллер при
  SIGINT/SIGTERM, чтобы shell получил терминал после cleanup.
- `RunStore.createDisplayJournal()` исключительно создаёт `display/<UUID>.jsonl` на участок команды;
  `DisplayJournal` хранит индекс byte offsets и читает страницы. `LogView` держит только метаданные,
  open-id и ограниченный LRU-кэш страниц; кадры не журналируются, `events.jsonl` не меняется.
- Колесо в управляемом окне двигает историю на одну визуальную строку, без таймера выключения мыши.
  Пока followTail выключен, новые записи сохраняются без сдвига якоря; End и конец истории возвращают
  слежение. PageUp/PageDown работают без mouse wheel reporting. Раскрытый текст не обрезается высотой
  окна, resize пересчитывает layout и попадания старых блоков.
- На диалог `terminalDialog()` удерживает кадры, снимает мышь/raw и скрывает панель; Inquirer работает
  в том же альтернативном экране. Новые записи сохраняются сразу, итог меню — семантическая запись
  один раз. Resume возвращает якорь и open-id; cleanup снимает подписки и выводит canonical preview
  со ссылками на основном экране один раз. Ошибка журнала закрывает окно и сохраняет текущую запись
  в потоковом выводе; повторный cleanup не допечатывает transcript.
- Raw-режим stdin в libuv оставляет `ONLCR`, но выключает `ISIG`/`ECHO`: Ctrl+C приходит байтом `\x03`,
  и `mouse.ts` шлёт `process.kill(0, 'SIGINT')` всей группе процессов (обёртка, tsx, CLI ролей).
- Файлы размышлений — `thinking/<UUID>-<роль>.md`, запись `wx` с повтором при коллизии; старые
  нумерованные файлы не меняются. OSC 8 строится через `pathToFileURL`, терминатор BEL. «Развернуть»
  и «Полный текст» в открытом блоке сохраняют доступ к файлу; после закрытия transcript всегда
  содержит preview и ссылку. Короткий блок со ссылкой тоже сохраняет доступ к полному файлу.
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
- Лимиты раундов не жёсткие: 3 авто, дальше решает человек. Waiver по выбору — только в фазе спеки;
  после freeze находки снимаются только переходом дальше всей петли (решение 26.10.2026).
- `--auto-until-review` (решение 27.10.2026): автопилот до «Принять change?», там run паркуется
  (`awaiting-review`, код 0, приёмка — `resume`). Автопилот режима не выбирает waiver и переход дальше;
  после парковки или BLOCKED решения run принимает человек (`handover` в `state.json`).
- Лимиты спеки на автопилоте жёсткие (решение 02.11.2026): `artifactRounds`/`holisticRounds` не
  продлеваются — после последнего ревью с находками одна правка автора без ревью, петля проходит
  (`closeLoop(…, 'autopilot')`, `passedBy: 'autopilot'`), вопросы без раунда правки — только запись
  ответа (`unapplied`). Иначе автор и ревьюер порождают друг другу работу без конца. Петли кода — как были.
- Блокер роли (BLOCKED ревьюера, спор security/behavior, `NEEDS_SPEC_CHANGE`) — диалог с рекомендацией
  «Остановить run», а не обрыв; сразу BLOCKED — только контроль целостности (решение 26.10.2026).
- Выключить в настройках run можно всё, кроме spec-author: шаг роли пропускается (`on(ctx, роль)`).
  Без implementer run только со спекой (`specRun`): этапы apply, acceptance, final пропускаются,
  archive не выполняется — дельты уходят в `openspec/specs` только с кодом, change остаётся активным;
  code-reviewer и acceptance-tester выключаются вместе с ним (решения 26.10 и 27.10.2026).
- Route моделей не используются: модели из `/model`, effort через SDK.
- В чужом репозитории OpenSpec берётся как есть (схема, changes, версия CLI); kit даёт только роли,
  рубрики и policy по умолчанию.
- Прогресс задач — галочками в файле задач (digest их нормализует) и в `state.json`.
- Run по умолчанию в основном дереве на ветке `agentflow/<change>`, worktree — флагом `--worktree`
  (решение 30.10.2026): работу видно сразу в редакторе. Один run на дерево (lock в `.git`), чужие
  незакоммиченные правки — только предупреждение, они уходят в коммит freeze. Режим — `state.worktree
  === repoRoot`, старые run на worktree продолжают resume.
- Контракт ревью роль читает из копии `contexts/review.schema.json`: в целевом репозитории
  `.agentflow/review.schema.json` нет, а читать роли могут только дерево run и `contexts/`.

## Не сделано

Команды `/opsx:*` и `/spec-*` для gigacode; `.gigacode/settings.json`; контейнер, sandbox, сетевой
allowlist; хуки и MCP-источники требований (MCP-инструменты ролям даёт `roles.<роль>.mcp`); Claude Doc не обновлён под возврат spec-author.
На gigacode конвейер запущен у пользователя после правки id моделей; все петли целиком проверены
на mock-ролях (демо kit и чужой репозиторий со схемой spec-driven).
