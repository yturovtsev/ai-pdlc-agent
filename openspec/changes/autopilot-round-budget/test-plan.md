# Test Plan

## Scope

Capability `spec-phase`:

- «Лимит раундов спеки на автопилоте»: «Один раунд артефакта», «Последняя правка с ошибкой валидации»,
  «Один раунд сквозного ревью», «Без автопилота».
- «Вопросы без раунда правки»: «Вопрос в последней правке».

Capability `human-decisions`:

- «Диалог при исчерпании лимита» (MODIFIED): «Артефакт не сходится» (регрессия), «Артефакт не сходится
  на автопилоте».

## Environment

- Kit с зависимостями (`npm install`), Node ≥ 22.13.
- **Mock-прогоны.** Копия kit с `git init -b main` и начальным коммитом. Лимиты задаются правкой
  `limits` в `.agentflow/policy.yaml` копии. Команда: `node tools/agentflow/bin/agentflow.mjs run
  tasks/01-slugify.md --mock <флаги>`, stdout в файл, stdin из `/dev/null`. Каждый прогон — в новой
  копии. Журнал — `.agentflow-runs/<run>/events.jsonl`, состояние — `state.json` (`loops`,
  `proceeded`, `spec.questions`), отчёт — `ACCEPTANCE.md`.
- **Офлайн-модули.** `e2e/autopilot-budget.test.js` (node:test) импортирует через tsx
  `tools/agentflow/autopilot.ts` (`autopilotStep`, `budgetPassReason`) и `tools/agentflow/report.ts`
  (`writeAcceptanceReport`).

## Scenarios

| Requirement | Scenario | Steps (inputs) | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| Лимит раундов спеки на автопилоте | Один раунд артефакта | `artifactRounds: 1`, `--auto-approve --inject artifact-stuck:specs` | код 0; в `loops` по `artifact:specs` вердикты `REVISE`, `AUTOPILOT`; ревью specs в `events.jsonl` одно; следующая петля — design; `proceeded` содержит `artifact:specs` с `by: "autopilot"` | `e2e/evidence/budget-artifact.txt` |
| Лимит раундов спеки на автопилоте | Последняя правка с ошибкой валидации | `autopilotStep(2, 1)` и сценарий кода: при `final` ошибка `validateArtifact` ведёт в `artifactExhausted` | `autopilotStep` — `final`; в mock — проверка чтением `controller.ts` (точки inject для ошибки валидации нет) | `e2e/evidence/budget-validator.txt` |
| Лимит раундов спеки на автопилоте | Один раунд сквозного ревью | `holisticRounds: 1`, `--auto-approve --inject holistic-revise` | код 0; `holistic`: `REVISE`, `AUTOPILOT`; сквозное ревью в журнале одно; в `ACCEPTANCE.md` раздел «Пройдено автопилотом по лимиту раундов» с `holistic` | `e2e/evidence/budget-holistic.txt` |
| Лимит раундов спеки на автопилоте | Без автопилота | `writeAcceptanceReport` с `proceeded` без `by` | запись — в «Пройдено решением человека», раздела автопилота нет | `e2e/evidence/budget-report.json` |
| Вопросы без раунда правки | Вопрос в последней правке | прогон из «Один раунд артефакта» | `spec.questions` по specs с `unapplied: true`; петли `artifact:specs` после согласования нет; в `ACCEPTANCE.md` раздел «Ответы автопилота, не внесённые в спеку» | `e2e/evidence/budget-questions.txt` |
| Диалог при исчерпании лимита | Артефакт не сходится на автопилоте | `--auto-approve --inject all` (лимиты по умолчанию) | код 0; `artifact:specs`: три `REVISE`, затем `AUTOPILOT`; решения `exhausted:specs` нет; `exhausted:batch 2` есть | `e2e/evidence/budget-inject-all.txt` |
| Диалог при исчерпании лимита | Артефакт не сходится (регрессия) | `--auto-until-review --inject artifact-stuck:specs,artifact-revise:proposal` с `artifactRounds: 1` | код 0, статус `awaiting-review`; `proposal` и `specs` пройдены автопилотом; «Режим прогона»: `пройдено по лимиту раундов: 2` | `e2e/evidence/budget-until-review.txt` |

## Evidence

- `e2e/evidence/autopilot-budget.log` — вывод `node --import tsx --test e2e/autopilot-budget.test.js`.
- `e2e/evidence/budget-*.txt` — выдержки из `state.json`, лога и `ACCEPTANCE.md` mock-прогонов.

## Manual check

1. В своём репозитории поставь `limits.artifactRounds: 1` в `.agentflow/policy.yaml` и запусти
   `agentflow run "<intent>" --auto-until-review`.
2. В логе у артефакта с находками: одно ревью, строка «автопилот: раунды ревью … исчерпаны», вердикт
   `AUTOPILOT`, затем следующий артефакт.
3. В `ACCEPTANCE.md` запаркованного run проверь разделы «Пройдено автопилотом по лимиту раундов» и
   «Ответы автопилота, не внесённые в спеку».
