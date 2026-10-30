# Spec Delta

## MODIFIED Requirements

### Requirement: Сквозное ревью и freeze
После принятия всех артефактов новый spec-reviewer SHALL проверить пакет целиком; freeze SHALL проходить, только если каждый артефакт принят на текущей редакции, сквозное ревью дало PASS и `openspec validate --strict` чист. Если spec-reviewer выключен в настройках run, сквозного ревью SHALL не быть, а freeze SHALL требовать только принятых артефактов и чистого `openspec validate --strict`.

#### Scenario: Заморозка
- **WHEN** условия выполнены и человек выбрал «Заморозить»
- **THEN** digest спеки записан в `state.json`, спека закоммичена в ветку run, дальше меняются только код и тесты

#### Scenario: Заморозка без spec-reviewer
- **WHEN** spec-reviewer выключен, все артефакты приняты человеком и `openspec validate --strict` чист
- **THEN** после фазы спеки сразу открывается «Заморозить спеку и запустить apply?», сквозное ревью в сводке петель — SKIPPED
