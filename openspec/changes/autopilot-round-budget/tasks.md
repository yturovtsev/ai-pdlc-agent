# Tasks

## 1. Лимит петель спеки на автопилоте

- [x] 1.1 `autopilot.ts`: `autopilotStep`, `budgetPassReason` (design, решение 1). Проверка: unit-тесты — `autopilotStep(1, 1)` даёт `final`, `(2, 3)` — `round`; причина называет ключ и значение лимита.
- [x] 1.2 `controller.ts` `artifactRounds`: бюджет на автопилоте не продлевается, флаг `final`, последняя правка без ревью, `closeLoop(…, 'autopilot')`, ошибка валидации — `artifactExhausted` (решение 1). Проверка: копия kit с `artifactRounds: 1`, `run tasks/01-slugify.md --mock --auto-approve --inject artifact-stuck:specs` — код 0, `artifact:specs: REVISE → AUTOPILOT`.
- [x] 1.3 `controller.ts` `holisticRounds`: проход по лимиту после `reaccept` (решение 2). Проверка: копия kit с `holisticRounds: 1`, `--inject holistic-revise` — `holistic: REVISE → AUTOPILOT`, run принят.

## 2. Вопросы и отчёт

- [x] 2.1 `answerUnapplied` после прохода по лимиту и в `stageApproval` (решение 3), `Question.unapplied`. Проверка: mock из 1.2 — вопрос Q-1 по specs с `unapplied: true`, петля specs на согласовании не повторяется.
- [x] 2.2 `state.ts` (`passedBy`, `Proceeded.by`), `report.ts` (разделы автопилота, счётчик «Режим прогона»), строка «Принять change?» (решение 4). Проверка: unit-тесты отчёта.

## 3. Документация

- [x] 3.1 README (раздел «Лимит раундов спеки на автопилоте», таблица петель, режим `--auto-until-review`), AGENTS.md, комментарий `limits` в `.agentflow/policy.yaml`, описание `artifact-stuck` в `inject.ts`. Проверка: `npm run lint`.
