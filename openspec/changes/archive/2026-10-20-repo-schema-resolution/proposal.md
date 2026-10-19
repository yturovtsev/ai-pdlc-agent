# Proposal

## Why

В чужом репозитории с кастомной схемой (`schema` в `openspec/config.yaml`)
run падал на `openspec new change` с `Unknown schema … Available: spec-driven`. OpenSpec, запущенный
в worktree, схему не видел: каталог схемы не доезжал до worktree, если был в `.gitignore`, а встроенную
схему корпоративной сборки `openspec` из PATH не знал CLI kit, который выбирался раньше PATH. Вдобавок
`openspec.schema: agentflow` из policy kit уходил как `--schema` в любой репозиторий без `agentflow init`
и перебивал его `config.yaml`. Всё это нарушает требование «OpenSpec репозитория как есть».

## What Changes

- Часть репозитория: конвейер agentflow (`tools/agentflow/`), демо-библиотека не меняется.
- `openspec/config.yaml` и `openspec/schemas/` основного дерева переносятся в worktree, даже если они в
  `.gitignore`; закоммиченные файлы не перезаписываются.
- До создания change контроллер проверяет, что схема change видна CLI. Если CLI по умолчанию
  (репозиторий → kit → PATH) её не видит, берётся другой установленный `openspec`, который видит; выбор
  сохраняется в `state.json`, и `resume` использует тот же CLI.
- Если схему не видит ни один CLI, run останавливается до создания change и перечисляет, какие схемы
  видит каждый CLI и где OpenSpec ищет схемы.
- Policy kit больше не задаёт `openspec.schema`: схема kit (`agentflow`) берётся из его `config.yaml`.
- OpenSpec без `sourcePath` в задачах apply (1.13 и старше) даёт понятную ошибку о версии вместо TypeError.

Вне scope: поддержка OpenSpec < 1.14 в фазе apply; поиск схем в нестандартных каталогах и
standalone store; выбор CLI по версии; команды `/opsx:*` для gigacode.

## Capabilities

### New Capabilities

### Modified Capabilities

- `target-repo`: требование «OpenSpec репозитория как есть» дополняется видимостью схемы в worktree,
  выбором CLI по схеме и остановкой до создания change.

## Impact

- Код: `tools/agentflow/openspec.ts` (выбор CLI, `ensureSchema`, проверка `sourcePath`),
  `controller.ts` (перенос схем в worktree, проверка до `new change`, CLI в state для resume),
  `state.ts` (`versions.openspecBin`), `.agentflow/policy.yaml` (`openspec.schema: ""`).
- Тесты: `tools/agentflow/agentflow.test.ts`.
- Документация: README (раздел о чужих репозиториях), AGENTS.md (неочевидные факты).
- Совместимость: репозиторий, где `.agentflow/policy.yaml` явно задаёт схему, ведёт себя как раньше;
  прогоны, начатые до изменения, при `resume` берут CLI по умолчанию.
