# Spec Delta

## MODIFIED Requirements

### Requirement: Целевой репозиторий
Целевой репозиторий SHALL определяться как git-корень каталога запуска или `--repo`; прогоны SHALL храниться в его `.agentflow-runs/`.

#### Scenario: Запуск из подкаталога
- **WHEN** `agentflow run` вызван из подкаталога репозитория
- **THEN** целевым считается git-корень, ветка run создаётся от его HEAD

### Requirement: OpenSpec репозитория как есть
Контроллер SHALL использовать схему из `openspec/config.yaml` или `.openspec.yaml` change, её граф артефактов и `apply.tracks`, существующие changes и `openspec` из `node_modules` репозитория, если он установлен. Policy kit SHALL NOT задавать схему за репозиторий; схемы и config основного дерева SHALL быть доступны OpenSpec в дереве run, даже если они не в git.

#### Scenario: Схема spec-driven
- **WHEN** в репозитории схема spec-driven без test-plan
- **THEN** артефакты идут как proposal → specs → design → tasks, acceptance строится из сценариев specs

#### Scenario: Кастомная схема в .gitignore
- **WHEN** `openspec/config.yaml` задаёт схему, каталог которой лежит в `openspec/schemas/` под `.gitignore`
- **THEN** change создаётся в дереве run (основном или worktree) с этой схемой, а не со схемой по умолчанию

#### Scenario: Репозиторий без своей policy
- **WHEN** в репозитории нет `.agentflow/policy.yaml`, а `openspec/config.yaml` задаёт кастомную схему
- **THEN** change создаётся с кастомной схемой репозитория, а не со схемой kit

### Requirement: Существующий change
`agentflow run --change <id>` SHALL сначала ревьюить уже написанные артефакты и пропускать уточнение intent. Незакоммиченное состояние `openspec/` SHALL оставаться видимым run: в основном дереве оно переходит на ветку run, в worktree контроллер его переносит.

#### Scenario: Написан только proposal
- **WHEN** выполняется `run --change` для change, где есть только proposal
- **THEN** proposal идёт на ревью без генерации, остальные артефакты пишет spec-author

#### Scenario: Незакоммиченный change в worktree
- **WHEN** proposal change не закоммичен и выполняется `run --change <id> --worktree`
- **THEN** proposal есть в worktree и идёт на ревью без генерации

### Requirement: Слои настроек
Policy kit SHALL сливаться с `.agentflow/policy.yaml` репозитория (объекты по ключам, списки заменой); роли и рубрики репозитория SHALL заменять одноимённые из kit; для артефакта без своей рубрики используется `artifact.md`.

#### Scenario: Свои гейты
- **WHEN** в `.agentflow/policy.yaml` задано `gates.ops.lint: npm run lint`
- **THEN** гейт lint и вызов `agentflow-gate lint` ролью выполняют `npm run lint` в дереве run
