# review-contract Specification

## Purpose
Ответ ревьюера — JSON по контракту, привязанный к snapshot проверяемой редакции; переход разрешает валидатор контракта по правилам принятия.

## Requirements

### Requirement: Контракт ответа
Контроллер SHALL принимать только JSON со status PASS, REVISE или BLOCKED, ожидаемыми role и target, snapshotId проверяемой редакции, checks и findings по `.agentflow/review.schema.json`; битый JSON, пустой ответ и таймаут — ошибка шага, а не вердикт.

#### Scenario: Битый JSON
- **WHEN** ответ ревьюера не содержит JSON-объекта
- **THEN** запускается новый экземпляр ревьюера с причиной отказа в промпте

#### Scenario: Чужой snapshot
- **WHEN** snapshotId ответа не совпадает с проверяемым
- **THEN** ответ отклоняется как вердикт к другой редакции

### Requirement: Обязательные проверки рубрики
Каждая проверка из раздела «Обязательные проверки» рубрики SHALL присутствовать в checks; NOT_VERIFIED по обязательной проверке SHALL превращать ответ в BLOCKED.

#### Scenario: Пропущена обязательная проверка
- **WHEN** в checks нет проверки из рубрики
- **THEN** ответ отклоняется валидатором контракта

### Requirement: Правила принятия
Находки critical и major SHALL блокировать переход, minor и nit SHALL только попадать в журнал; PASS при critical или major — невалидный ответ; находка без evidence или location отбрасывается.

#### Scenario: Только minor
- **WHEN** ответ REVISE содержит лишь находки minor
- **THEN** решение — PASS, находки записаны в журнал

### Requirement: Трассировка требований
Финальное ревью SHALL содержать traceability для каждого requirementId индекса требований, acceptance — check на каждый сценарий индекса.

#### Scenario: Непокрытое требование
- **WHEN** в traceability финального ревью нет одного из требований
- **THEN** ответ отклоняется валидатором контракта

### Requirement: Решения, требующие человека
Находка с `needsHuman: true` SHALL в фазе спеки становиться вопросом человеку, а в фазе apply — переводить шаг в BLOCKED.

#### Scenario: Развилка в apply
- **WHEN** code-reviewer пометил находку needsHuman
- **THEN** run переходит в BLOCKED
