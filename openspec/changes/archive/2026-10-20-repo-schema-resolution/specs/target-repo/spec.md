## MODIFIED Requirements

### Requirement: OpenSpec репозитория как есть
Контроллер SHALL использовать схему из `openspec/config.yaml` или `.openspec.yaml` change, её граф артефактов и `apply.tracks`, существующие changes и `openspec` из `node_modules` репозитория, если он установлен. Policy kit SHALL NOT задавать схему за репозиторий; схемы и config основного дерева SHALL быть доступны OpenSpec в worktree, даже если они не в git.

#### Scenario: Схема spec-driven
- **WHEN** в репозитории схема spec-driven без test-plan
- **THEN** артефакты идут как proposal → specs → design → tasks, acceptance строится из сценариев specs

#### Scenario: Кастомная схема в .gitignore
- **WHEN** `openspec/config.yaml` задаёт схему, каталог которой лежит в `openspec/schemas/` под `.gitignore`
- **THEN** change создаётся в worktree с этой схемой, а не со схемой по умолчанию

#### Scenario: Репозиторий без своей policy
- **WHEN** в репозитории нет `.agentflow/policy.yaml`, а `openspec/config.yaml` задаёт кастомную схему
- **THEN** change создаётся с кастомной схемой репозитория, а не со схемой kit

## ADDED Requirements

### Requirement: OpenSpec CLI по схеме change
Перед созданием или продолжением change контроллер SHALL проверить, что схема change видна выбранному `openspec`. Если CLI по умолчанию (репозиторий, затем kit, затем PATH) её не видит, контроллер SHALL взять другой установленный `openspec`, который её видит, и SHALL использовать его же при `resume`.

#### Scenario: Схема только у CLI из PATH
- **WHEN** схему видит только `openspec` из PATH (встроенная схема корпоративной сборки)
- **THEN** run создаёт change этим CLI, а `resume` продолжает тем же CLI

#### Scenario: Схему не видит ни один CLI
- **WHEN** схемы из config нет ни в проекте, ни в пользовательском каталоге OpenSpec, ни в сборке установленных CLI
- **THEN** run останавливается до создания change и state прогона; сообщение называет схему, перечисляет схемы, которые видит каждый CLI, и места, где OpenSpec ищет схемы
