# target-repo Specification

## Purpose
Конвейер работает в любом локальном git-репозитории с его собственным OpenSpec; kit поставляет только роли, рубрики, policy по умолчанию и код контроллера.

## Requirements

### Requirement: Целевой репозиторий
Целевой репозиторий SHALL определяться как git-корень каталога запуска или `--repo`; прогоны SHALL храниться в его `.agentflow-runs/`.

#### Scenario: Запуск из подкаталога
- **WHEN** `agentflow run` вызван из подкаталога репозитория
- **THEN** целевым считается git-корень, worktree создаётся от его HEAD

### Requirement: OpenSpec репозитория как есть
Контроллер SHALL использовать схему из `openspec/config.yaml` или `.openspec.yaml` change, её граф артефактов и `apply.tracks`, существующие changes и `openspec` из `node_modules` репозитория, если он установлен.

#### Scenario: Схема spec-driven
- **WHEN** в репозитории схема spec-driven без test-plan
- **THEN** артефакты идут как proposal → specs → design → tasks, acceptance строится из сценариев specs

### Requirement: Существующий change
`agentflow run --change <id>` SHALL переносить незакоммиченное состояние `openspec/` в worktree, сначала ревьюить уже написанные артефакты и пропускать уточнение intent.

#### Scenario: Написан только proposal
- **WHEN** выполняется `run --change` для change, где есть только proposal
- **THEN** proposal идёт на ревью без генерации, остальные артефакты пишет spec-author

### Requirement: Слои настроек
Policy kit SHALL сливаться с `.agentflow/policy.yaml` репозитория (объекты по ключам, списки заменой); роли и рубрики репозитория SHALL заменять одноимённые из kit; для артефакта без своей рубрики используется `artifact.md`.

#### Scenario: Свои гейты
- **WHEN** в `.agentflow/policy.yaml` задано `gates.ops.lint: npm run lint`
- **THEN** гейт lint и вызов `agentflow-gate lint` ролью выполняют `npm run lint` в worktree

### Requirement: Подключение репозитория
`agentflow init` SHALL создавать `.agentflow/policy.yaml` с гейтами из скриптов `package.json` или падающими заглушками TODO и строки `.gitignore`, не изменяя существующий `openspec/`.

#### Scenario: OpenSpec уже настроен
- **WHEN** в репозитории есть `openspec/` со своей схемой
- **THEN** init сообщает схему и changes и не меняет файлы `openspec/`
