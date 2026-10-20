# Tasks

## 1. Allowlist MCP в policy и ACL

- [x] 1.1 Добавить `RolePolicy.mcp?: string[]` (`policy.ts`) и `mcp: []` с комментарием у ролей `.agentflow/policy.yaml`; проверить `npm run typecheck`
- [x] 1.2 Разрешать в `decideAcl` имена `mcp__…` по шаблонам `mcp` роли, кроме шага `readOnly`, с причиной «шаблон …» или «нет в roles.<роль>.mcp»; проверить unit-тестами в `agentflow.test.ts`: разрешённый, вне allowlist, роль без `mcp`, шаг readOnly

## 2. Опции сессии и сверка вызовов

- [x] 2.1 Вынести построение инструментальных опций сессии в экспортируемую функцию (`roles.ts`): `coreTools` без `mcp__…`, `excludeTools` с `mcp__*` при пустом `mcp` или `readOnly`, `allowedMcpServerNames` из шаблонов с явным сервером; проверить unit-тестами: пустой `mcp`, readOnly, `mcp__jira__*`, `mcp__*`
- [x] 2.2 Собирать имена MCP-вызовов в `RoleResult.mcpCalls` и показывать MCP-серверы со статусом в строке «сессия открыта» (`roles.ts`); проверить unit-тестом функции сверки (`mcpViolations`): вызов вне allowlist, все вызовы в allowlist
- [x] 2.3 Переводить run в BLOCKED при нарушении сверки в `callRole` и `callReviewer` (`controller.ts`); проверить `npm run typecheck` и mock-прогоном `run tasks/01-slugify.md --mock --auto-approve --inject all` в копии kit до archive

## 3. Диагностика, smoke и документация

- [x] 3.1 Предупреждать при загрузке ролей о `mcp__…` в `tools:`, не покрытых `mcp` policy (`controller.ts`); проверить unit-тестом и mock-прогоном во временном репозитории с переопределённым spec-author
- [x] 3.2 Добавить в `smoke.ts` группу `mcp` со stdio-серверами `smoke-mcp-server.mjs` (SDK-серверам CLI доверяет): роль без `mcp` не выполняет MCP-инструментов, названный сервер виден, а не названный нет, ask-инструмент вне allowlist отклонён ACL, readOnlyHint-вызов вне allowlist даёт нарушение сверки; проверить `npm run typecheck` (запуск на моделях — при приёмке)
- [x] 3.3 Описать `roles.<роль>.mcp` в README (policy ролей, где взять имя инструмента) и факты о MCP в CLI 0.1.8 в AGENTS.md; проверить `npm run lint` и `openspec validate role-mcp-tools --strict`
