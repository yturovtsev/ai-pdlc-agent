# Test Plan

## Scope

Capability `pipeline-orchestration`:

- «Диалог настроек run»: «Выключить code-reviewer», «Подтвердить без изменений», «Обязательная роль»,
  «Автопилот в настройках».
- «Выключение ролей без диалога»: «Запуск из скрипта», «Обязательная роль во флаге».
- «Настройки прогона в состоянии и отчёте»: «Resume с выключенной ролью», «Отчёт».

Capability `spec-phase`:

- «Петля артефакта» (MODIFIED): «Ревьюер вернул major» (регрессия), «Без spec-reviewer».
- «Сквозное ревью и freeze» (MODIFIED): «Заморозка» (регрессия), «Заморозка без spec-reviewer».

Capability `apply-phase`:

- «Петля батча» (MODIFIED): «Красный гейт» (регрессия), «Батч без code-reviewer».
- «Acceptance по спеке» (MODIFIED): «Упавший сценарий» (регрессия), «Без acceptance-tester».
- «Финальное ревью» (MODIFIED): «Находка в коде» (регрессия), «Финал без code-reviewer».

## Environment

- Kit с зависимостями (`npm install`), Node ≥ 22.13.
- **Mock-прогоны.** Копия kit с `git init` и начальным коммитом: mock создаёт ветку и worktree.
  Команда: `node tools/agentflow/bin/agentflow.mjs run tasks/01-slugify.md --mock <флаги>`, stdout в
  файл, stdin из `/dev/null`. Каждый прогон — в новой копии kit. Журнал —
  `.agentflow-runs/<run>/events.jsonl` (событие `spawn` с полем `role` — запуск роли), состояние —
  `state.json`, отчёт — `ACCEPTANCE.md`. `resume` — `node tools/agentflow/bin/agentflow.mjs resume <run>`.
- **Интерактивные сценарии** — псевдотерминал `e2e/helpers/pty-run.py` (`pty.fork`, 30×120, запуск
  `python3 -I`, клавиши по таймеру: `↓` — `\x1b[B`, пробел — галочка, Enter — `\r`). Если хелпера
  нет, его создаёт acceptance-tester. В меню настроек порядок пунктов: spec-author, spec-reviewer,
  implementer, code-reviewer, acceptance-tester, «Уточнение intent», «Автопилот».
- **Офлайн-модули.** `e2e/run-settings.test.js` (node:test) импортирует через tsx
  (`node --import tsx --test e2e/run-settings.test.js`) `tools/agentflow/run-settings.ts` (разбор флага,
  пункты меню, итог меню) и `tools/agentflow/human.ts` (`new Human(false, io)` со сценарием `checkbox`).
  Имена экспортов — по коду.

## Scenarios

| Requirement | Scenario | Steps (inputs) | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| Диалог настроек run | Выключить code-reviewer | pty: `run tasks/01-slugify.md --mock`. В меню настроек `↓` три раза, пробел, Enter. Остальные меню — Enter | В выводе строка «выключены роли: code-reviewer». В `events.jsonl` нет `spawn` с `role: code-reviewer`. В `state.json` `options.skip` = `["code-reviewer"]` | `e2e/evidence/settings-pty-skip.raw` |
| Диалог настроек run | Подтвердить без изменений | pty: тот же запуск, в меню настроек сразу Enter | `options.skip` пуст, `clarify: true`, `autoApprove: false`. Есть `spawn` всех пяти ролей | `e2e/evidence/settings-pty-default.raw` |
| Диалог настроек run | Обязательная роль | pty: в меню `↓` два раза (implementer), пробел, Enter. Модули: пункты меню | В выводе у spec-author и implementer пометка «обязательная роль». После Enter `options.skip` не содержит implementer. Модули: у обязательных `checked` и `disabled` | `e2e/evidence/settings-pty-required.raw` |
| Диалог настроек run | Автопилот в настройках | pty: `↓` до «Автопилот», пробел, Enter. Дальше клавиш не слать | Run доходит до конца без ввода, код 0. В выводе `(--auto-approve)` у решений. `state.json` `options.autoApprove: true` | `e2e/evidence/settings-pty-auto.raw` |
| Диалог настроек run | (негатив) Без TTY нет диалога | `run tasks/01-slugify.md --mock --auto-approve` со stdout в файл | В выводе нет меню настроек, прогон как раньше, код 0 | `e2e/evidence/settings-mock-plain.log` |
| Выключение ролей без диалога | Запуск из скрипта | Mock: `--auto-approve --skip-roles code-reviewer,acceptance-tester` | Код 0. Нет `spawn` code-reviewer и acceptance-tester. В `e2e/` worktree нет новых тестов. Change архивирован | `e2e/evidence/settings-mock-skip.log` |
| Выключение ролей без диалога | Обязательная роль во флаге | `run tasks/01-slugify.md --mock --skip-roles implementer` | Код ≠ 0, сообщение со списком «spec-reviewer, code-reviewer, acceptance-tester». Новой ветки `agentflow/add-slugify` и каталога `.agentflow-runs/` нет | `e2e/evidence/settings-mock-required.log` |
| Выключение ролей без диалога | (негатив) Неизвестная роль | `--skip-roles reviewer` | Код ≠ 0, сообщение называет «reviewer» и допустимые роли, ветки нет | `e2e/evidence/settings-mock-required.log` |
| Настройки прогона в состоянии и отчёте | Resume с выключенной ролью | Mock: `--auto-approve --skip-roles code-reviewer --inject kill-after:apply`, затем `resume` | Первый прогон — код 137. `resume` — код 0, в его выводе нет сессий code-reviewer, финал — только полные гейты | `e2e/evidence/settings-mock-resume.log` |
| Настройки прогона в состоянии и отчёте | Отчёт | Mock: `--auto-approve --skip-roles spec-reviewer,acceptance-tester` | В `ACCEPTANCE.md` раздел «Настройки прогона» называет обе роли и шаги: ревью артефактов, сквозное ревью, acceptance. Сводка петель содержит SKIPPED | `e2e/evidence/settings-mock-report.log` |
| Петля артефакта | Ревьюер вернул major | Mock: `--auto-approve --inject artifact-revise:proposal` | Как раньше: proposal 2 раунда, REVISE → PASS | `e2e/evidence/settings-mock-plain.log` |
| Петля артефакта | Без spec-reviewer | Тот же прогон, что «Отчёт» | Нет `spawn` spec-reviewer. Для каждого артефакта есть «Твоё ревью артефакта», в сводке `artifact:<id>` — SKIPPED | `e2e/evidence/settings-mock-report.log` |
| Сквозное ревью и freeze | Заморозка | Любой mock-прогон без `--skip-roles` | `state.json` `spec.freeze.digest` есть | `e2e/evidence/settings-mock-plain.log` |
| Сквозное ревью и freeze | Заморозка без spec-reviewer | Тот же прогон, что «Отчёт» | После фазы спеки сразу «Заморозить спеку и запустить apply?», `holistic` в сводке — SKIPPED, freeze записан | `e2e/evidence/settings-mock-report.log` |
| Петля батча | Красный гейт | Mock: `--auto-approve --skip-roles code-reviewer --inject gate-red:1` | Гейт батча 1 красный, затем зелёный, батч принят без ревью | `e2e/evidence/settings-mock-gate.log` |
| Петля батча | Батч без code-reviewer | Тот же прогон, что «Запуск из скрипта» | Задачи батчей в `tasks.md` архива отмечены `[x]`, `batch:<id>` в сводке — SKIPPED | `e2e/evidence/settings-mock-skip.log` |
| Acceptance по спеке | Упавший сценарий | Регрессия: в рамках этого change не меняется, покрыт прогоном `--inject all` | Код 0, сводка как раньше | `e2e/evidence/settings-mock-all.log` |
| Acceptance по спеке | Без acceptance-tester | Тот же прогон, что «Запуск из скрипта» | Нет фазы `ACCEPTANCE`, в диалоге «Принять change?» строка «acceptance не запускался» | `e2e/evidence/settings-mock-skip.log` |
| Финальное ревью | Находка в коде | Mock: `--auto-approve --inject final-revise` | Как раньше: final REVISE → PASS | `e2e/evidence/settings-mock-all.log` |
| Финальное ревью | Финал без code-reviewer | Тот же прогон, что «Запуск из скрипта» | Полные гейты зелёные, нет `spawn` code-reviewer в финале. В `ACCEPTANCE.md` нет трассировки, есть «ревью кода выключено» | `e2e/evidence/settings-mock-skip.log` |

## Evidence

- `e2e/evidence/run-settings.log` — вывод `node --import tsx --test e2e/run-settings.test.js`.
- `e2e/evidence/settings-mock-*.log` — вывод mock-прогонов с выдержками из `state.json`, `events.jsonl`
  и `ACCEPTANCE.md`.
- `e2e/evidence/settings-pty-*.raw` — сырой вывод псевдотерминала и выдержки из `state.json`.

## Manual check

1. В iTerm2 запустить `npm run agentflow -- run tasks/01-slugify.md --mock`: перед стартом меню с
   галочками, spec-author и implementer серые с пометкой «обязательная роль».
2. Снять code-reviewer и acceptance-tester, подтвердить: в логе «выключены роли», ревью кода и
   acceptance не запускаются, в `ACCEPTANCE.md` раздел «Настройки прогона».
3. На gigacode запустить настоящий run с выключенным spec-reviewer и убедиться, что каждый артефакт
   сразу приходит на твоё ревью.
