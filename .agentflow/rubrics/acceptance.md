# Рубрика: acceptance

`checks[]` содержит ровно по одному элементу на каждый сценарий из индекса требований задачи, `id` = id сценария.
Упавший сценарий: check FAIL плюс находка с `requirementId`, evidence из e2e/evidence/ и `severity` major или critical.
Сценарий, который невозможно проверить снаружи: NOT_VERIFIED с причиной в `note`.
`traceability[]` — по элементу на сценарий: requirementId, scenarioId, tests (путь к тесту), evidence (путь к файлу).

Статус: PASS, если все сценарии PASS; REVISE, если есть упавшие; BLOCKED, если тесты невозможно запустить.
