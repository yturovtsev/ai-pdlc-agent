# Test Plan

## Scope

Capability `pipeline-orchestration`:

- «Порядок этапов» (MODIFIED): «Новый run», «Run в worktree».
- «Run в основном дереве»: «Второй run в том же дереве», «Чужие правки при старте», «Resume на чужой
  ветке», «Итог run».

Capability `target-repo`:

- «Целевой репозиторий» (MODIFIED): «Запуск из подкаталога» (регрессия).
- «OpenSpec репозитория как есть» (MODIFIED): «Кастомная схема в .gitignore» (регрессия, оба режима).
- «Существующий change» (MODIFIED): «Написан только proposal» (регрессия), «Незакоммиченный change в worktree».
- «Слои настроек» (MODIFIED): «Свои гейты» (регрессия).

Capability `role-sessions`:

- «ACL по умолчанию запрещает» (MODIFIED): «Запись в каталог прогонов».
- «Сверка изменений после роли» (MODIFIED): «Отчёт приёмки в дереве».
- «Контракт ответа ревью доступен роли»: «Репозиторий без схемы».

Capability `spec-phase`:

- «Сквозное ревью и freeze» (MODIFIED): «Заморозка» (регрессия).

## Environment

- Kit с зависимостями (`npm install`), Node ≥ 22.13.
- **Mock-прогоны.** Копия kit с `git init -b main` и начальным коммитом: run основного дерева
  переключает ветку копии и коммитит в неё. Команда: `node tools/agentflow/bin/agentflow.mjs run
  tasks/01-slugify.md --mock --auto-approve <флаги>`, stdout в файл, stdin из `/dev/null`. Каждый
  прогон — в новой копии kit. Журнал — `.agentflow-runs/<run>/events.jsonl`, состояние — `state.json`,
  отчёт — `ACCEPTANCE.md`, lock — `.git/agentflow.lock`.
- **Офлайн-модули.** `e2e/run-tree.test.js` (node:test) импортирует через tsx
  (`node --import tsx --test e2e/run-tree.test.js`) `tools/agentflow/run-tree.ts`, `tools/agentflow/roles.ts`
  (`decideAcl`) и `tools/agentflow/review-validator.ts` (`contractExample`). Имена экспортов — по коду.

## Scenarios

| Requirement | Scenario | Steps (inputs) | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| Порядок этапов | Новый run | mock-прогон без флагов в копии на `main` | код 0; `git branch --show-current` — `agentflow/add-slugify`; `git log main..HEAD` — коммиты контроллера | `e2e/evidence/main-tree-run.txt`: ветка и `git log --oneline main..HEAD` |
| Порядок этапов | Run в worktree | mock-прогон с `--worktree` | код 0; ветка копии — `main`; `git worktree list` содержит `.agentflow-runs/<run>/worktree` | `e2e/evidence/worktree-run.txt` |
| Run в основном дереве | Второй run в том же дереве | записать в `.git/agentflow.lock` `{runId:"busy",pid:<живой процесс>}`, запустить mock-прогон | код ≠ 0; сообщение с `busy` и `--worktree`; веток `agentflow/*` нет | `e2e/evidence/tree-lock.txt` |
| Run в основном дереве | Чужие правки при старте | дописать строку в `README.md`, mock-прогон | лог предупреждает о `README.md`; `README.md` в `git show --stat` коммита freeze | `e2e/evidence/foreign-dirty.txt` |
| Run в основном дереве | Resume на чужой ветке | после прогона: `status` в `state.json` → `blocked`, `git switch main`, `resume <run>` | код ≠ 0; сообщение с `git switch agentflow/add-slugify` | `e2e/evidence/resume-branch.txt` |
| Run в основном дереве | Итог run | `ACCEPTANCE.md` прогона основного дерева | есть `git -C <repo> switch main` и `merge agentflow/add-slugify`, нет `worktree remove` | `e2e/evidence/main-tree-report.md` |
| Целевой репозиторий | Запуск из подкаталога | mock-прогон из `src/` | целевой — корень копии, ветка run от его HEAD | `e2e/evidence/subdir-run.txt` |
| OpenSpec репозитория как есть | Кастомная схема в .gitignore | схема в `openspec/schemas/` под `.gitignore`, прогон в обоих режимах | `.openspec.yaml` change называет кастомную схему | `e2e/evidence/ignored-schema.txt` |
| Существующий change | Написан только proposal | `run --change` с одним proposal | первый шаг proposal — ревью без генерации | `e2e/evidence/existing-change.txt` |
| Существующий change | Незакоммиченный change в worktree | незакоммиченный proposal, `run --change <id> --worktree` | proposal в worktree, ревью без генерации | `e2e/evidence/existing-change-worktree.txt` |
| Слои настроек | Свои гейты | `gates.ops.lint` в policy копии | `gates/*lint*.log` содержит вывод своей команды из дерева run | `e2e/evidence/own-gates.txt` |
| ACL по умолчанию запрещает | Запись в каталог прогонов | `decideAcl(rt, 'implementer', false, 'write_file', {file_path: '.agentflow-runs/r/state.json'})` | `ok: false`, причина «каталог прогонов пишет только контроллер» | `e2e/evidence/acl-runs-dir.json` |
| Сверка изменений после роли | Отчёт приёмки в дереве | `treeChanges(['.agentflow-runs/r/ACCEPTANCE.md', 'src/a.js'])` | `['src/a.js']` | `e2e/evidence/tree-changes.json` |
| Контракт ответа ревью доступен роли | Репозиторий без схемы | mock-прогон; промпты `contexts/*review*.md` | каждый называет `<run>/contexts/review.schema.json`, файл равен схеме kit; `.agentflow/review.schema.json` в промптах нет | `e2e/evidence/schema-path.txt` |
| Сквозное ревью и freeze | Заморозка | mock-прогон | `state.json` содержит `spec.freeze.commit`, коммит в ветке run | `e2e/evidence/freeze-commit.txt` |

## Evidence

- `e2e/evidence/run-tree.log` — вывод `node --import tsx --test e2e/run-tree.test.js`.
- `e2e/evidence/*.txt` — вывод mock-прогонов с выдержками из `git`, `state.json`, лога и промптов `contexts/`.
- `e2e/evidence/main-tree-report.md` — `ACCEPTANCE.md` прогона основного дерева.

## Manual check

1. В своём репозитории на `main` выполни `agentflow run "<intent>"` и открой изменённые файлы в редакторе во время фазы спеки.
2. Убедись, что `git branch --show-current` — `agentflow/<change>`, а `.agentflow-runs/<run>/` содержит `contexts/review.schema.json`.
3. Во втором терминале запусти ещё один `agentflow run` — он должен отказать и предложить `--worktree`.
4. После приёмки выполни шаги merge из итога: `git switch main && git merge agentflow/<change>`.
