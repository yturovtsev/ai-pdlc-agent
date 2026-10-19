# Test Plan

## Scope

Capability `target-repo`:

- «OpenSpec репозитория как есть» — сценарии «Схема spec-driven», «Кастомная схема в .gitignore»,
  «Репозиторий без своей policy».
- «OpenSpec CLI по схеме change» — сценарии «Схема только у CLI из PATH», «Схему не видит ни один CLI».

## Environment

- Kit с установленными зависимостями (`npm install`), команда `node <kit>/tools/agentflow/bin/agentflow.mjs`.
- Целевой репозиторий — временный каталог: `git init`, `openspec init --tools none --no-animation .`,
  без `.agentflow/policy.yaml`. Кастомная схема — копия `node_modules/@fission-ai/openspec/schemas/spec-driven`
  с изменённым `name:`.
- «Корпоративный» CLI — скрипт `openspec` во временном каталоге, добавленном в начало PATH, который
  запускает OpenSpec kit с `XDG_DATA_HOME`, где лежит схема (её видит только он).
- Intent — файл `intent.md` с одной строкой заголовка. Роли — `--mock --auto-approve`, stdin из `/dev/null`.

## Scenarios

| Requirement                   | Scenario                            | Steps (inputs)                                                                       | Expected result                                                                                                                                                                                               | Evidence                                  |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| OpenSpec репозитория как есть | Схема spec-driven                   | Временный репозиторий с `schema: spec-driven`; `run intent.md --mock --auto-approve` | В логе `схема OpenSpec: spec-driven · артефакты: proposal → specs → design → tasks`                                                                                                                           | `e2e/evidence/schema-spec-driven.log`     |
| OpenSpec репозитория как есть | Кастомная схема в .gitignore        | `openspec/schemas/` в `.gitignore`, `schema: my-corp-edition`; run                   | Лог `схема OpenSpec: my-corp-edition`; `.openspec.yaml` change в worktree содержит `schema: my-corp-edition`; `git ls-files` в ветке не содержит `openspec/schemas/`                                          | `e2e/evidence/schema-gitignored.log`      |
| OpenSpec репозитория как есть | Репозиторий без своей policy        | Тот же репозиторий без `.agentflow/policy.yaml`                                      | Схема change — из config, не `agentflow`; нет ошибки про схему `agentflow`                                                                                                                                    | `e2e/evidence/schema-no-policy.log`       |
| OpenSpec CLI по схеме change  | Схема только у CLI из PATH          | `schema`, схема только в `XDG_DATA_HOME` скрипта-обёртки; run с этим PATH            | Лог `OpenSpec … (<путь обёртки>)` и `схема OpenSpec`; `state.json` → `versions.openspecBin` = путь обёртки                                                                                                    | `e2e/evidence/schema-path-cli.log`        |
| OpenSpec CLI по схеме change  | Схема только у CLI из PATH (resume) | После предыдущего: `resume` того же run                                              | Продолжает без ошибки схемы, CLI в логе — обёртка                                                                                                                                                             | `e2e/evidence/schema-path-cli-resume.log` |
| OpenSpec CLI по схеме change  | Схему не видит ни один CLI          | `schema: nope`; run                                                                  | Код выхода ≠ 0; сообщение содержит «не видит схему «nope»», по строке на каждый CLI со списком схем и места поиска; в `.agentflow-runs/<run>/` нет `state.json`, `openspec/changes/<id>` в worktree не создан | `e2e/evidence/schema-missing.log`         |
| OpenSpec CLI по схеме change  | (негатив) Явная схема policy        | `.agentflow/policy.yaml` с `openspec.schema: spec-driven`, config — кастомная схема  | Change создан со `spec-driven`                                                                                                                                                                                | `e2e/evidence/schema-policy-explicit.log` |

## Evidence

Полный вывод каждого прогона (stdout + stderr) и копии `state.json` / `.openspec.yaml` change —
в `e2e/evidence/` под именами из таблицы.

## Manual check

1. В своём репозитории с кастомной схемой выполни `agentflow run <intent>`: в логе `схема OpenSpec:` —
   твоя схема, путь `OpenSpec … (…)` — ожидаемый CLI.
2. Поставь в `openspec/config.yaml` несуществующую схему и запусти run: сообщение объясняет, что
   видит каждый CLI, ветка и state не созданы.
3. Запусти mock-прогон kit: `npm run agentflow -- run tasks/01-slugify.md --mock --auto-approve --inject all`
   в копии kit — доходит до archive со схемой `agentflow`.
