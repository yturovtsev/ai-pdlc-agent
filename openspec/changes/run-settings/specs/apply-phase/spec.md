# Spec Delta

## MODIFIED Requirements

### Requirement: Петля батча
Контроллер SHALL запускать implementer, затем гейты batch через `agentflow-gate`, коммит и ревью новым code-reviewer; при REVISE следующий раунд идёт в той же сессии implementer, с третьего раунда — новым implementer со сводкой провалов. Если code-reviewer выключен в настройках run, батч с зелёными гейтами SHALL приниматься после коммита без ревью, а красные гейты SHALL вести петлю, как раньше.

#### Scenario: Красный гейт
- **WHEN** гейт lint красный
- **THEN** implementer той же сессии получает вывод гейта, гейты запускаются снова, не больше gateAttempts раз за вызов

#### Scenario: Батч без code-reviewer
- **WHEN** code-reviewer выключен, а гейты батча 1 зелёные
- **THEN** сессии code-reviewer нет, батч 1 принят, его задачи отмечены в файле задач, в сводке петель ревью батча — SKIPPED

### Requirement: Acceptance по спеке
acceptance-tester SHALL строить тесты из сценариев спеки и плана приёмки, если он есть в схеме, в каталог `acceptance.dir`, запускать их и сохранять evidence; production-код он не меняет. Если acceptance-tester выключен в настройках run, этап acceptance SHALL пропускаться.

#### Scenario: Упавший сценарий
- **WHEN** acceptance-тест сценария падает
- **THEN** check сценария FAIL и находка с requirementId уходят в финальное ревью

#### Scenario: Без acceptance-tester
- **WHEN** acceptance-tester выключен
- **THEN** после apply сразу идёт финал, acceptance-тестов в worktree нет, финальное ревью получает отметку, что acceptance выключен, а диалог «Принять change?» сообщает, что acceptance не запускался

### Requirement: Финальное ревью
Контроллер SHALL запускать полные гейты и финальное ревью трассировки; при REVISE исправляет implementer (код) или acceptance-tester (тесты), затем гейты и ревью повторяются на новом snapshot. Если code-reviewer выключен в настройках run, финал SHALL состоять из полных гейтов: зелёные завершают его, красные исправляет implementer, после лимита раундов открывается диалог исчерпания. Если acceptance-tester выключен, находки по тестам SHALL исправлять implementer.

#### Scenario: Находка в коде
- **WHEN** финальное ревью вернуло major по файлу вне каталога acceptance-тестов
- **THEN** находку исправляет новый implementer, затем полные гейты и ревью запускаются снова

#### Scenario: Финал без code-reviewer
- **WHEN** code-reviewer выключен, а полные гейты зелёные
- **THEN** финального ревью нет, этап завершён, в отчёте приёмки трассировки нет и указано, что ревью кода выключено
