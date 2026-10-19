# apply-phase Specification

## Purpose
После freeze конвейер реализует задачи батчами с гейтами и ревью кода, проверяет change по сценариям спеки, проводит финальное ревью трассировки и передаёт change на приёмку.

## Requirements

### Requirement: Батчи из задач OpenSpec
Контроллер SHALL брать задачи из `openspec instructions apply`, группировать их по заголовкам файла задач и пропускать уже отмеченные; принятый батч SHALL отмечаться галочками в файле задач.

#### Scenario: Часть задач уже выполнена
- **WHEN** все задачи группы отмечены `[x]`
- **THEN** батч считается выполненным и не запускается

### Requirement: Петля батча
Контроллер SHALL запускать implementer, затем гейты batch через `agentflow-gate`, коммит и ревью новым code-reviewer; при REVISE следующий раунд идёт в той же сессии implementer, с третьего раунда — новым implementer со сводкой провалов.

#### Scenario: Красный гейт
- **WHEN** гейт lint красный
- **THEN** implementer той же сессии получает вывод гейта, гейты запускаются снова, не больше gateAttempts раз за вызов

### Requirement: Acceptance по спеке
acceptance-tester SHALL строить тесты из сценариев спеки и плана приёмки, если он есть в схеме, в каталог `acceptance.dir`, запускать их и сохранять evidence; production-код он не меняет.

#### Scenario: Упавший сценарий
- **WHEN** acceptance-тест сценария падает
- **THEN** check сценария FAIL и находка с requirementId уходят в финальное ревью

### Requirement: Финальное ревью
Контроллер SHALL запускать полные гейты и финальное ревью трассировки; при REVISE исправляет implementer (код) или acceptance-tester (тесты), затем гейты и ревью повторяются на новом snapshot.

#### Scenario: Находка в коде
- **WHEN** финальное ревью вернуло major по файлу вне каталога acceptance-тестов
- **THEN** находку исправляет новый implementer, затем полные гейты и ревью запускаются снова

### Requirement: Приёмка и archive
Контроллер SHALL писать `ACCEPTANCE.md`, запрашивать решение человека и при принятии выполнять `openspec archive`; merge ветки — вне конвейера.

#### Scenario: Change принят
- **WHEN** человек выбрал «Принять»
- **THEN** выполняется `openspec archive`, результат коммитится в ветку change, run получает статус accepted
