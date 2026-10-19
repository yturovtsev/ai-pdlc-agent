# Tasks

## 1. Схема видна в worktree

- [x] 1.1 Переносить `openspec/config.yaml` и `openspec/schemas/` основного дерева в worktree без перезаписи (`controller.ts`, `startRun`) и проверить: во временном репозитории со схемой под `.gitignore` лог показывает `схема OpenSpec: <кастомная>`
- [x] 1.2 Убрать `openspec.schema` из policy kit (`.agentflow/policy.yaml`) и проверить: репозиторий без своей policy создаёт change со схемой из своего config, mock-прогон kit берёт `agentflow` из config и доходит до archive

## 2. Выбор OpenSpec CLI по схеме

- [x] 2.1 Добавить `OpenSpec.schemas()` и `ensureSchema` (имя схемы как у OpenSpec, перебор CLI репозиторий → kit → PATH, ошибка со списком схем каждого CLI) и проверить unit-тестами в `agentflow.test.ts`: схема проекта, схема только у CLI из PATH, схемы нет нигде, явная схема policy
- [x] 2.2 Вызывать `ensureSchema` до `store.save()` и `new change`, сохранять CLI в `state.versions.openspecBin` и передавать его в `OpenSpec` при `resume` (`controller.ts`, `state.ts`); проверить `npm run typecheck` и прогоном со схемой, которую видит только обёртка в PATH (`openspecBin` в state — путь обёртки)
- [x] 2.3 Явная ошибка «нужен OpenSpec ≥ 1.14» в `applyTasks`, если задачи без `sourcePath`; проверить вызовом `applyTasks` через OpenSpec 1.13

## 3. Документация

- [x] 3.1 Описать выбор CLI и перенос схем в README (раздел «Запуск в других репозиториях») и неочевидные факты OpenSpec в AGENTS.md; проверить, что `npm run lint` и `openspec validate repo-schema-resolution --strict` проходят
