# Test Plan

## Scope

Capability `human-decisions`:

- «Автопилот до ревью человека» (ADDED): «Спека и код без человека», «Оба флага».
- «Автопилот не снимает блокирующие находки» (ADDED): «Автор оспорил все находки», «Находки не
  сходятся», «Точка перехода дальше».
- «Передача решений человеку» (ADDED): «Resume после BLOCKED», «Resume после убитого контроллера».

Capability `apply-phase`:

- «Приёмка и archive» (MODIFIED): «Change принят» (регрессия), «Парковка на приёмке», «Приёмка
  после парковки», «Resume парковки без TTY».
- «Режим прогона в отчёте приёмки» (ADDED): «Отчёт запаркованного run», «Run без режима».

## Environment

- Kit с зависимостями (`npm install`), Node ≥ 22.13.
- **Mock-прогоны.** Каждый прогон — в новой копии kit с `git init` и начальным коммитом: mock
  создаёт ветку и worktree. Команда: `node tools/agentflow/bin/agentflow.mjs run tasks/01-slugify.md --mock <флаги>`,
  stdout и stderr в файл, stdin из `/dev/null` (нет TTY). Run id — из вывода. Состояние —
  `.agentflow-runs/<run>/state.json`, отчёт — `ACCEPTANCE.md`, журнал — `events.jsonl`.
  `resume` — `node tools/agentflow/bin/agentflow.mjs resume <run>`, статус — `… status <run>`.
  Код выхода сохраняется рядом с выводом.
- **Интерактивные сценарии** — псевдотерминал `e2e/helpers/pty-run.py` (`pty.fork`, 30×120, запуск
  `python3 -I`; клавиши по таймеру: Enter — `\r`, `↓` — `\x1b[B`). Меню и пункты ищутся по тексту
  в выводе. Если хелпера нет, его создаёт acceptance-tester.
- **Офлайн-модули.** Где снаружи не воспроизвести (автор оспорил все находки — mock-автор так не
  отвечает), тест `e2e/auto-until-review.test.js` (node:test) импортирует модули через tsx
  (`node --import tsx --test e2e/auto-until-review.test.js`):
  - `tools/agentflow/autopilot.ts` — выбор автопилота вместо рекомендации, включён ли автопилот
    по опциям и передаче, проверка флагов;
  - `tools/agentflow/dialogs.ts` — `askHuman` с автопилотом режима и точкой `proceed:<петля>`;
  - `tools/agentflow/report.ts` — `writeAcceptanceReport` на состоянии с режимом и без.
  Имена экспортов — по коду.

## Scenarios

| Requirement | Scenario | Steps (inputs) | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| Автопилот до ревью человека | Спека и код без человека | Mock: `--auto-until-review --inject all`, без TTY | Код 0. В выводе решения уточнения, «Твоё ревью артефакта …» каждого артефакта и «Заморозить спеку…» с отметкой `(--auto-until-review) →`; в сводке петель батчи, acceptance и финал; строки `(--auto-approve) →` нет | `e2e/evidence/until-review-run.log` |
| Автопилот до ревью человека | Оба флага | Mock: `--auto-approve --auto-until-review` | Код ≠ 0, сообщение называет оба флага; `git branch` копии без `agentflow/*`, каталога `.agentflow-runs/` нет или он пуст | `e2e/evidence/until-review-flags.log` |
| Автопилот не снимает блокирующие находки | Автор оспорил все находки | Офлайн: выбор автопилота для рекомендации `waive`; для `more`, `hint`, `stop` | Для `waive` — ключ `more` и причина про находки critical/major; для остальных — без замены | `e2e/evidence/until-review-pick.log` |
| Автопилот не снимает блокирующие находки | Автор оспорил все находки (снаружи) | Mock: `--auto-until-review --inject artifact-stuck:specs` | В выводе диалог «Артефакт «specs»: 3 автоматических раунда без PASS», выбран не waiver; в `state.json` нет решений `gate: waiver`, раздел waiver в `ACCEPTANCE.md` — «(нет)» | `e2e/evidence/until-review-stuck.log` |
| Автопилот не снимает блокирующие находки | Находки не сходятся | Офлайн: `askHuman` автопилота режима с рекомендацией «Остановить» (третье исчерпание) | Выбран «Остановить», вызывающий получает `Blocked`; переход дальше не выбран | `e2e/evidence/until-review-stop.log` |
| Автопилот не снимает блокирующие находки | Точка перехода дальше | Mock: `--auto-until-review --inject batch-stuck:1,proceed:batch:1` | В выводе строка, что переход дальше по `proceed:batch:1` пропущен; `state.json`: `proceeded` пуст, у батча 1 нет `passedBy`; run запаркован | `e2e/evidence/until-review-proceed.log` |
| Автопилот не снимает блокирующие находки | Точка перехода дальше (офлайн) | Офлайн: `askHuman` автопилота режима в области петли, точка `proceed:<петля>` сработала | Возвращён рекомендуемый ключ, `PassLoop` не брошен; тот же вызов с обычным автопилотом бросает `PassLoop` (регрессия) | `e2e/evidence/until-review-proceed-offline.log` |
| Передача решений человеку | Resume после BLOCKED | Mock: `--auto-until-review --inject blocked:batch:1` → код 2; затем `resume` в псевдотерминале | После первого прогона в `state.json` `status: blocked` и `handover` с причиной BLOCKED. При resume первый диалог ждёт ввода (после его заголовка нет строки `(--auto-until-review) →`); Enter на каждом диалоге, включая «Принять change?» — код 0, статус `accepted`, парковки нет | `e2e/evidence/until-review-handover.log` |
| Передача решений человеку | Resume после BLOCKED без TTY | То же, `resume` со stdin из `/dev/null` | Код 2, причина — нужен TTY для решения; автопилот решение не принял | `e2e/evidence/until-review-handover-notty.log` |
| Передача решений человеку | Resume после убитого контроллера | Mock: `--auto-until-review --inject kill-after:spec` → код 137; затем `resume` без TTY | В `state.json` после убийства нет `handover`. Resume: решения apply с отметкой `(--auto-until-review) →`, код 0, статус `awaiting-review` | `e2e/evidence/until-review-kill.log` |
| Приёмка и archive | Change принят | Mock: `--auto-approve` (без режима) | Код 0, `openspec archive` выполнен, статус `accepted`, «Принять change?» выбран автопилотом | `e2e/evidence/until-review-regress.log` |
| Приёмка и archive | Парковка на приёмке | Run из «Спека и код без человека»; затем `status <run>` | Код 0; `status` — `awaiting-review`, этап `human-acceptance`; в worktree change не заархивирован (`openspec/changes/<change>/` на месте, нет коммита archive); в выводе путь к `ACCEPTANCE.md`, worktree, ветка, `agentflow resume <run>`; в выводе после сообщения о парковке нет `ESC[` сброса панели в середине строк (stdout не TTY — панели нет вовсе) | `e2e/evidence/until-review-park.log` |
| Приёмка и archive | Приёмка после парковки | Запаркованный run; `resume` в псевдотерминале, Enter | Ролей не запускается (в выводе нет `▶ субагент`), сразу «Принять change?» с рекомендацией «Принять → openspec archive»; после Enter — archive, статус `accepted`, код 0 | `e2e/evidence/until-review-accept.log` |
| Приёмка и archive | Отклонение после парковки | Запаркованный run; `resume` в псевдотерминале, `↓`, Enter, причина «не то», Enter | Статус `rejected`, причина в `state.json` и `ACCEPTANCE.md`, archive не выполнен | `e2e/evidence/until-review-reject.log` |
| Приёмка и archive | Resume парковки без TTY | Запаркованный run; `resume` со stdin из `/dev/null` | Код 2, сообщение про TTY; `state.json` — `awaiting-review`, `ACCEPTANCE.md` побайтно тот же | `e2e/evidence/until-review-park-notty.log` |
| Режим прогона в отчёте приёмки | Отчёт запаркованного run | `ACCEPTANCE.md` run из «Парковка на приёмке» | Статус «ждёт ревью человека»; раздел «Режим прогона»: режим, число решений автопилота > 0 и равно числу решений в `state.json`, передача «парковка на приёмке» с временем, открытых critical/major 0, waiver 0, переходов дальше 0 | `e2e/evidence/until-review-report.md` |
| Режим прогона в отчёте приёмки | Run без режима | `ACCEPTANCE.md` run из «Change принят»; офлайн: отчёт на состоянии без `untilReview` | Раздела «Режим прогона» нет | `e2e/evidence/until-review-report-off.log` |

## Evidence

В `e2e/evidence/`: вывод каждого mock-прогона и resume с кодом выхода в последней строке,
выдержки `state.json` (`status`, `options`, `handover`, `proceeded`, решения), копии
`ACCEPTANCE.md`, транскрипты псевдотерминала, вывод офлайн-теста. Имена — из таблицы.

## Manual check

1. В копии kit: `npm run agentflow -- run tasks/01-slugify.md --mock --auto-until-review` в
   терминале — ни одного вопроса, в конце сообщение о парковке с командой resume, терминал чистый
   (нет панели, курсор под логом).
2. `agentflow status` — run в `awaiting-review`; открыть `ACCEPTANCE.md` из сообщения и раздел
   «Режим прогона».
3. `agentflow resume <run-id>` — сразу «Принять change?», принять; `agentflow status` — `accepted`.
4. `agentflow run … --auto-approve --auto-until-review` — понятная ошибка, ветки нет.
