# Tasks

## 1. Режим автопилота: состояние и чистые функции

- [x] 1.1 `state.ts`: `options.untilReview?: boolean`, `handover?: { at: string; reason: string }`, статус `'awaiting-review'` в `RunState.status`. `RunStore.load` читает старый `state.json` без новых полей. Проверка: unit-тест в `agentflow.test.ts` — состояние без `untilReview` и `handover` загружается, режим считается выключенным.
- [x] 1.2 Новый `tools/agentflow/autopilot.ts` по design: `autopilotOn(options, handover)`, `autopilotLabel(options)`, `untilReviewPick(recommended)` (только `waive` → `more` с причиной), `checkModeFlags(autoApprove, untilReview)`. Проверка: unit-тесты — таблица `autopilotOn` (без флагов, `autoApprove`, режим без передачи, режим с передачей), `untilReviewPick` для `waive`, `more`, `hint`, `stop`, сообщение `checkModeFlags` называет оба флага.
- [x] 1.3 `human.ts`: `Human` получает отметку автопилота для лога и флаг `strict`; при `--auto-approve` лог прежний. `dialogs.ts`: при `human.strict` точка `proceed:<петля>` берётся (`take`), переход не выбирается, лог «режим --auto-until-review: переход дальше по proceed:<петля> пропущен». Проверка: unit-тесты в `dialogs.test.ts` — автопилот режима в области петли со сработавшей точкой возвращает рекомендацию без `PassLoop`, обычный автопилот по-прежнему бросает `PassLoop`; отметка `(--auto-until-review) →` в выводе `choose`.

## 2. Флаг и автопилот в контроллере

- [x] 2.1 `controller.ts`: флаг `--auto-until-review` в `parseArgs` и `USAGE`, `checkModeFlags` в `startRun` до создания ветки и worktree, `options.untilReview` в `state.json`, строка режима в начале лога, `makeCtx` строит `Human` через `autopilotOn` и `autopilotLabel`. Проверка: `npm run typecheck && npm run lint && npm run test:agentflow`; в копии kit `run tasks/01-slugify.md --mock --auto-approve --auto-until-review` — ошибка, `agentflow/*` веток нет.
- [x] 2.2 `controller.ts`: в `artifactExhausted` и в исчерпании сквозного ревью `autoPick` из `untilReviewPick(recommended)` при `options.untilReview`; рекомендация и обоснование для человека прежние. Проверка: в копии kit `--mock --auto-until-review --inject artifact-stuck:specs` — диалог исчерпания specs решён без waiver, в `state.json` нет решений `gate: waiver`.

## 3. Парковка на приёмке и передача решений

- [x] 3.1 `util.ts`: класс `Parked` (не наследник `Blocked`). `controller.ts`: `stageHumanAcceptance` бросает `Parked`, если `ctx.human.auto` и `options.untilReview`; `pipeline` ловит `Parked`: `status = 'awaiting-review'`, `handover` «парковка на приёмке», `ACCEPTANCE.md`, manifest, сводка петель, сообщение с отчётом, worktree, веткой и `agentflow resume <run-id>`, код выхода 0. Проверка: в копии kit `--mock --auto-until-review --inject all` — код 0, `agentflow status` — `awaiting-review` на `human-acceptance`, коммита archive в ветке нет.
- [x] 3.2 `controller.ts`: `Blocked` в режиме без `handover` пишет `handover` с причиной BLOCKED; `failed` и `kill-after` его не пишут. `resumeRun`: для `awaiting-review` без TTY — сообщение про TTY, статус и отчёт не меняются, код 2. `showStatus` и `showChanges`: колонка статуса вмещает `awaiting-review`. Проверка: в копии kit — `resume </dev/null` запаркованного run даёт код 2 и прежний статус; `--inject kill-after:spec` и `resume` — apply автопилотом, парковка; `--inject blocked:batch:1`, затем `resume </dev/null` — BLOCKED «нужно решение человека», а не выбор автопилота.

## 4. Отчёт приёмки и документация

- [x] 4.1 `report.ts`: шапка «ждёт ревью человека» для `awaiting-review`; раздел «Режим прогона» только при `options.untilReview` — режим, решения автопилота (до `handover.at`, все без передачи), передача с временем и причиной, открытые critical/major, waiver, переходы дальше. Проверка: unit-тест `writeAcceptanceReport` — на состоянии режима с парковкой раздел и счётчики есть, без `untilReview` раздела нет, отчёт `--auto-approve` прежний.
- [x] 4.2 README: режим `--auto-until-review` (что решает автопилот, почему не waiver и не переход дальше, парковка, resume, код выхода, передача решений после BLOCKED), строка в таблице флагов. AGENTS.md: `autopilot.ts` в карте, в «Решения» — режим до ревью человека паркуется на приёмке, автопилот режима не снимает блокирующие находки. Проверка: флаги в README совпадают с `USAGE`; `--mock --auto-approve --inject all` в копии kit — код 0, сводка петель как до change.
