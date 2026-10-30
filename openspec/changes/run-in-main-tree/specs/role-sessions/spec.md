# Spec Delta

## MODIFIED Requirements

### Requirement: ACL по умолчанию запрещает
Контроллер SHALL разрешать роли запись только по glob `write`/`denyWrite` её policy в пределах дерева run и никогда — в `.agentflow-runs/`, shell — только `agentflow-gate <операция>` из списка роли, MCP-инструмент — только по шаблонам `mcp` её policy; любой другой вызов отклоняется.

#### Scenario: Запись в спеку
- **WHEN** implementer пишет файл в `openspec/`
- **THEN** `canUseTool` отклоняет вызов, в логе отмечается отказ ACL

#### Scenario: Запись в каталог прогонов
- **WHEN** implementer с `write: ["**"]` в run основного дерева пишет `.agentflow-runs/<run-id>/state.json`
- **THEN** `canUseTool` отклоняет вызов с причиной «каталог прогонов пишет только контроллер»

#### Scenario: Составная команда
- **WHEN** роль вызывает `agentflow-gate lint && git push`
- **THEN** вызов отклоняется

#### Scenario: Разрешённый MCP-инструмент
- **WHEN** в policy spec-author `mcp: ["mcp__jira__*"]` и spec-author вызывает `mcp__jira__get_issue`
- **THEN** вызов выполняется, в логе ACL отмечено разрешение с совпавшим шаблоном

#### Scenario: MCP-инструмент вне allowlist
- **WHEN** в policy spec-author `mcp: ["mcp__jira__get_issue"]` и spec-author вызывает `mcp__jira__create_issue`, на который CLI запрашивает разрешение
- **THEN** `canUseTool` отклоняет вызов, причина в логе называет ключ `roles.spec-author.mcp`

### Requirement: Сверка изменений после роли
После каждой пишущей роли контроллер SHALL сверять изменённые файлы дерева run, кроме `.agentflow-runs/`, с её ACL и переводить run в BLOCKED при нарушении.

#### Scenario: Файл вне полномочий
- **WHEN** после acceptance-tester изменён файл вне каталога acceptance-тестов
- **THEN** run переходит в BLOCKED со списком файлов

#### Scenario: Отчёт приёмки в дереве
- **WHEN** run основного дерева возвращён на доработку после отчёта, и `ACCEPTANCE.md` в `.agentflow-runs/<run-id>/` не закоммичен
- **THEN** сверка после implementer его не считает нарушением

## ADDED Requirements

### Requirement: Контракт ответа ревью доступен роли
Контроллер SHALL класть копию `review.schema.json` kit в `contexts/` run, а промпты spec-reviewer, code-reviewer и acceptance-tester SHALL ссылаться на эту копию абсолютным путём, а не на `.agentflow/review.schema.json`.

#### Scenario: Репозиторий без схемы
- **WHEN** в целевом репозитории нет `.agentflow/review.schema.json`, и spec-reviewer получает промпт ревью proposal
- **THEN** промпт называет `<run>/contexts/review.schema.json`, файл существует и совпадает со схемой kit
