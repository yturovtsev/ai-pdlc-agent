# Tasks

## 1. Настройки прогона и меню с галочками

- [x] 1.1 Новый `tools/agentflow/run-settings.ts` по design (решение 1): `ROLES`, `REQUIRED`, `SKIPPABLE`, `parseSkipRoles`, `settingsMenu`, `fromMenu`, `skippedSteps`. `controller.ts` берёт список ролей из `ROLES` вместо `ROLE_NAMES`. Проверка: unit-тесты — разбор `code-reviewer,acceptance-tester`, ошибка на `implementer` и на неизвестной роли с перечнем допустимых, пункты меню (обязательные отмечены и недоступны, начальные «Уточнение intent» и «Автопилот» из флагов), `fromMenu` включает обязательные, даже если их нет в ответе.
- [x] 1.2 `human.ts`: `PromptIO.checkbox` (по умолчанию `checkbox` из `@inquirer/prompts`) и `Human.checklist(title, items)` — без панели и мыши, лог удержан, автопилот возвращает исходные галочки. Проверка: unit-тест со сценарием `io` — в `checkbox` пришли пункты с `checked` и `disabled`, возвращены выбранные значения; `new Human(true)` возвращает отмеченные по умолчанию без вызова `io`.
- [x] 1.3 `state.ts`: `options.skip: string[]`, `RunStore.load` дополняет его `[]`. Проверка: unit-тест — старый `state.json` без поля загружается с `skip: []`.

## 2. Диалог при run и флаг `--skip-roles`

- [x] 2.1 `controller.ts` (`main`, `startRun`) по design (решение 3): флаг `--skip-roles` в `parseArgs` и USAGE. Диалог настроек после проверок intent и id change и до создания каталога run, если stdin и stdout — TTY, нет `--auto-approve` и `--skip-roles`. Итог — в `state.options` (`skip`, `clarify`, `autoApprove`), `Human` создаётся из итогового `autoApprove`. Ошибка `parseSkipRoles` — до создания ветки. Проверка: в копии kit `run tasks/01-slugify.md --mock --skip-roles implementer` — код ≠ 0, ветки `agentflow/add-slugify` и `.agentflow-runs/` нет. `--mock --auto-approve` со stdout в файл — меню нет, код 0.
- [x] 2.2 Строка «выключены роли: … · пропускаются: …» в начале `pipeline()`, панель считает включённые роли (design, решение 7). Проверка: `npm run typecheck && npm run lint && npm run test:agentflow`.

## 3. Пропуск шагов в фазе спеки

- [x] 3.1 `controller.ts` по design (решение 5): `on(ctx, роль)`. В `artifactRounds` при выключенном spec-reviewer после валидации и snapshot — `store.loop(…, 'SKIPPED', …)` и сразу ветка ревью человеком (вынести ветку PASS в функцию). `holisticLoop` без spec-reviewer — SKIPPED без петли, `freezeProblems` не требует сквозного ревью. `talk` фильтрует собеседников по `on`. Проверка: в копии kit `--mock --auto-approve --skip-roles spec-reviewer` — нет `spawn` spec-reviewer в `events.jsonl`, `artifact:*` и `holistic` в сводке SKIPPED, freeze записан, change архивирован.

## 4. Пропуск шагов в apply, acceptance и финале; отчёт

- [x] 4.1 `controller.ts`: при выключенном code-reviewer `batchRounds` после коммита идёт в ветку PASS (вынести в функцию), петля — SKIPPED. Без acceptance-tester `stageAcceptance` пишет SKIPPED и `acceptance.status: SKIPPED`. Проверка: в копии kit `--mock --auto-approve --skip-roles code-reviewer --inject gate-red:1` — гейт красный, затем батч принят без ревью, задачи отмечены.
- [x] 4.2 `controller.ts` `finalRounds` по design (решения 5, 6): без code-reviewer — полные гейты; зелёные → `final.status: GATES_ONLY`, красные → находка гейта critical, раунд implementer, после лимита — `applyExhausted`. Без acceptance-tester все находки финала — implementer. `context-builder.ts`: строка об отсутствии отчёта acceptance в промпте финального ревью. Диалог «Принять change?» — строки о выключенном acceptance и ревью кода. Проверка: unit-тест промпта финала с выключенным acceptance. В копии kit `--mock --auto-approve --skip-roles code-reviewer,acceptance-tester` — код 0, нет `spawn` code-reviewer и acceptance-tester. `--skip-roles code-reviewer --inject kill-after:apply`, затем `resume` — финал без ревью кода.
- [x] 4.3 `report.ts`: раздел «Настройки прогона» (выключенные роли, пропущенные шаги, уточнение intent, автопилот), в трассировке при `GATES_ONLY` — «ревью кода выключено». Проверка: unit-тест `writeAcceptanceReport` с `options.skip` и `final.status: GATES_ONLY`.

## 5. Документация

- [x] 5.1 README: диалог настроек при `run`, флаг `--skip-roles`, что пропускается при каждой выключенной роли, inject выключенной роли не действует. AGENTS.md: `run-settings.ts` в карте, решение «выключить можно только ревьюеров и тестера». Проверка: флаги в README совпадают с USAGE, `npm run lint`.

## 6. Run только со спекой и флаги в меню

- [x] 6.1 `run-settings.ts`: обязателен только spec-author, `normalizeSkip` (без implementer — и роли кода), `specOnly`, пункты «Автопилот до приёмки», «Панель статуса», «Мышь» с подсказками, `validateMenu`. `human.ts`: `checklist` с `validate`, подсказка пункта. Проверка: unit-тесты — разбор `implementer`, ошибка на `spec-author`, пункты меню и `AGENTFLOW_NO_PANEL`, два автопилота, `validate` уходит в `checkbox`.
- [x] 6.2 `controller.ts` по design (решение 8): пропуск apply, acceptance, final; диалог freeze; приёмка спеки и парковка; archive без `openspec archive`; галочки панели и мыши. `report.ts`: трассировка и ручная проверка run только со спекой. Проверка: в копии kit `--mock --auto-approve --skip-roles implementer` — код 0, change не в архиве; после merge `run --change add-slugify --mock --auto-approve` — код 0; `--auto-until-review --skip-roles implementer` — `awaiting-review`; меню в псевдотерминале не подтверждается с двумя автопилотами; `--inject all` — код 0.
- [x] 6.3 README и AGENTS.md: состав меню, run только со спекой.
