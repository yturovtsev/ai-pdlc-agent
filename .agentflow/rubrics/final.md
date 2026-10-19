# Рубрика: финальное ревью change

Проверяется весь diff apply-фазы, результаты полных гейтов и отчёт acceptance-tester.

## Обязательные проверки

- `FINAL-TRACE` — у каждого требования есть код, unit-тест и acceptance-evidence; `traceability[]` содержит каждое requirementId из индекса.
- `FINAL-GATES` — все полные гейты зелёные (красный — critical).
- `FINAL-ACCEPTANCE` — все сценарии acceptance PASS; упавший сценарий — находка с requirementId.
- `FINAL-SCOPE` — нет изменений вне scope proposal и вне разрешённых путей.

Поля `specCompliance` и `codeQuality` обязательны. Находка про acceptance-тест (location в каталоге acceptance-тестов) уходит acceptance-tester, остальные — implementer.
