# Spec Delta

## MODIFIED Requirements

### Requirement: Решения, требующие человека
Находка с `needsHuman: true` SHALL в фазе спеки становиться вопросом человеку, а в фазе apply — открывать диалог блокера.

#### Scenario: Развилка в apply
- **WHEN** code-reviewer пометил находку needsHuman
- **THEN** открывается диалог блокера с этой находкой; если выбрано «Остановить run», run переходит в BLOCKED
