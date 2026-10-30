# Tasks

## 1. Дерево run, lock и git

- [x] 1.1 Новый `tools/agentflow/run-tree.ts` по design (решения 2, 3): `RUNS_DIR`, `TREE_LOCK`, `inMainTree`, `treeChanges`, `foreignDirty`, `lockTree`, `mergeSteps`. Проверка: unit-тесты — lock живого процесса не пускает, мёртвого перехватывается, чужой run lock не снимает; правки вне change без каталога прогонов; шаги merge для обоих режимов.
- [x] 1.2 `git.ts`: `currentBranch`, `switchNew`, `branchExists`, `gitPath`, `ensureIgnored` (design, решение 4). Проверка: unit-тест во временном репозитории — ветка от `main` с незакоммиченным файлом, путь lock в `.git`, шаблон в `.git/info/exclude` дописывается один раз.

## 2. Контроллер, ACL и меню

- [x] 2.1 `controller.ts` `startRun` по design (решения 1, 5): основное дерево по умолчанию (lock, игнор, предупреждение о чужих правках, `git switch -c`), worktree с `--worktree` — как раньше; `state.startBranch`, `options.worktree`. `resumeRun` (решение 6): своя ветка и lock. `checkBoundary` и проверка целостности перед ревью кода — через `treeChanges`. Проверка: в копии kit `run tasks/01-slugify.md --mock --auto-approve --inject all` с изменённым `README.md` — код 0, предупреждение о `README.md`, ветка `agentflow/add-slugify` выбрана в основном дереве, lock снят; `--worktree` — ветка основного дерева прежняя.
- [x] 2.2 `roles.ts`: запрет записи в `.agentflow-runs/` в `decideAcl` (решение 3). Проверка: unit-тест — отказ для относительного и абсолютного пути и самого каталога, `.agentflow-runs-notes.md` разрешён.
- [x] 2.3 `run-settings.ts`: пункт «Отдельный worktree», `RunSettings.worktree`; флаг `--worktree` в `parseArgs` и USAGE. Проверка: unit-тесты меню.

## 3. Контракт ревью и отчёт

- [x] 3.1 `makeCtx` копирует `review.schema.json` kit в `contexts/`, `BaseCtx.schemaPath`, `contractExample({ schema })` во всех промптах ревьюеров и acceptance-tester (решение 7). Проверка: unit-тест строки контракта; в mock-прогоне промпты `contexts/*review*.md` называют `contexts/review.schema.json`, ни один не ссылается на `.agentflow/review.schema.json`.
- [x] 3.2 `report.ts` и итог archive: ветка от исходной, основное дерево, `mergeSteps`. Проверка: unit-тест `writeAcceptanceReport` основного дерева.

## 4. Документация

- [x] 4.1 README, AGENTS.md, комментарии `.agentflow/policy.yaml`: основное дерево по умолчанию, `--worktree`, один run на дерево, mock в kit переключает его ветку. Проверка: флаги README совпадают с USAGE, `npm run lint`.
