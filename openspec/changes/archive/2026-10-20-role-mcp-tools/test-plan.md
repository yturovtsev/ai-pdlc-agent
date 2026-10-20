# Test Plan

## Scope

Capability `role-sessions`:

- «ACL по умолчанию запрещает»: сценарии «Запись в спеку», «Составная команда» (без изменений,
  регрессия), «Разрешённый MCP-инструмент», «MCP-инструмент вне allowlist».
- «MCP-инструменты по policy»: сценарии «Роль без mcp не видит MCP», «Шаг только на чтение»,
  «Только названные серверы», «MCP-вызов в обход ACL».
- «Диагностика MCP роли»: сценарии «MCP только во frontmatter», «Сервер не подключился».

## Environment

- Kit с установленными зависимостями (`npm install`).
- Офлайн-часть: тесты в `e2e/role-mcp.test.js` (node:test) импортируют модули контроллера
  `tools/agentflow/roles.ts` и `policy.ts` через tsx (`node --import tsx --test`). Проверяются
  публичные функции: решение ACL (`decideAcl`), опции сессии роли (функция, которая строит
  `excludeTools`, `allowedMcpServerNames` и `coreTools`), сверка MCP-вызовов. Policy — объект из
  `loadPolicy` kit с подменой `roles.<роль>.mcp` в тесте.
- Часть на реальном CLI: `npm run smoke -- --only mcp` (нужны модели). Серверы `jira` и `confluence` —
  stdio-процессы `tools/agentflow/smoke-mcp-server.mjs`, они записывают выполненные инструменты в
  файл. У `jira` инструменты `get_issue` (ask), `create_issue` (ask) и `search` (`readOnlyHint`), у
  `confluence` — `get_page` (`readOnlyHint`).
- Диагностика при загрузке ролей: временный репозиторий (`git init`) с
  `.agentflow/agents/spec-author.md`, где в `tools:` есть `mcp__jira__get_issue`; run с `--mock
  --auto-approve`, stdin из `/dev/null`.

## Scenarios

| Requirement | Scenario | Steps (inputs) | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| ACL по умолчанию запрещает | Запись в спеку | `decideAcl` для implementer, `write_file` в `openspec/x.md` | `ok: false` | `e2e/evidence/role-mcp.log` |
| ACL по умолчанию запрещает | Составная команда | `decideAcl` для implementer, `run_shell_command` `agentflow-gate lint && git push` | `ok: false` | `e2e/evidence/role-mcp.log` |
| ACL по умолчанию запрещает | Разрешённый MCP-инструмент | spec-author `mcp: ["mcp__jira__*"]`; `decideAcl` для `mcp__jira__get_issue`, шаг не readOnly. Smoke: роль просят вызвать `get_issue` | `ok: true`, `reason` содержит `mcp__jira__*`. Smoke: ответ содержит результат инструмента, в `events.jsonl` событие `acl` с `allowed: true` | `e2e/evidence/role-mcp.log`, `.agentflow-runs/smoke-*/events.jsonl` |
| ACL по умолчанию запрещает | MCP-инструмент вне allowlist | spec-author `mcp: ["mcp__jira__get_issue"]`; `decideAcl` для `mcp__jira__create_issue`. Smoke: роль просят вызвать `create_issue` | `ok: false`, `reason` содержит `roles.spec-author.mcp`. Smoke: событие `acl` с `allowed: false`, инструмент не выполнен | `e2e/evidence/role-mcp.log`, smoke `events.jsonl` |
| ACL по умолчанию запрещает | (негатив) MCP у роли без mcp через ACL | spec-reviewer без `mcp`; `decideAcl` для `mcp__jira__get_issue` | `ok: false` | `e2e/evidence/role-mcp.log` |
| MCP-инструменты по policy | Роль без mcp не вызывает MCP | Опции сессии spec-reviewer без `mcp`. Smoke: сессия spec-reviewer с обоими серверами, роль просят вызвать все инструменты | `excludeTools` содержит `mcp__*`. Smoke: ни один инструмент, включая `confluence.get_page` и `jira.search` (readOnlyHint), не выполнен | `e2e/evidence/role-mcp.log`, smoke `events.jsonl` |
| MCP-инструменты по policy | Шаг только на чтение | Опции сессии spec-author с `mcp: ["mcp__jira__*"]`, `readOnly: true`; `decideAcl` для `mcp__jira__get_issue` с `readOnly: true` | `excludeTools` содержит `mcp__*`; `decideAcl` → `ok: false` | `e2e/evidence/role-mcp.log` |
| MCP-инструменты по policy | Только названные серверы | Опции сессии spec-author с `mcp: ["mcp__jira__*"]`. Smoke: сессия с обоими серверами | `allowedMcpServerNames` = `["jira"]`, в `excludeTools` нет `mcp__*`. Smoke: в init `mcp_servers` есть `jira` и нет `confluence`, `confluence.get_page` не выполнен | `e2e/evidence/role-mcp.log`, smoke `events.jsonl` |
| MCP-инструменты по policy | (негатив) Шаблон без сервера | `mcp: ["mcp__*"]` | `allowedMcpServerNames` не задан | `e2e/evidence/role-mcp.log` |
| MCP-инструменты по policy | MCP-вызов в обход ACL | Сверка для spec-author с `mcp: ["mcp__jira__get_issue"]` и вызовами `["mcp__jira__get_issue", "mcp__jira__search"]`. Smoke: роль просят вызвать `search` (readOnlyHint) | Сверка возвращает нарушение `mcp__jira__search`; контроллер бросает BLOCKED со списком. Smoke: проверка сверки красная для сессии | `e2e/evidence/role-mcp.log`, smoke отчёт |
| MCP-инструменты по policy | (негатив) Вызовы в allowlist | Сверка с вызовами только `mcp__jira__get_issue` | Нарушений нет | `e2e/evidence/role-mcp.log` |
| Диагностика MCP роли | MCP только во frontmatter | Временный репозиторий с переопределённым spec-author (`tools:` содержит `mcp__jira__get_issue`), без `mcp` в policy; `agentflow run intent.md --mock --auto-approve` | В выводе предупреждение с `mcp__jira__get_issue` и `roles.spec-author.mcp`; run продолжается | `e2e/evidence/role-mcp-frontmatter.log` |
| Диагностика MCP роли | Сервер не подключился | Smoke: spec-author с `mcp: ["mcp__wiki__*"]`, сервер `wiki` не настроен | В строке «сессия открыта» нет `wiki` или статус не `connected` | smoke вывод |

Сценарии smoke требуют реальных моделей и не выполняются офлайн. acceptance-tester проверяет их
логику офлайн-тестами из той же строки, а smoke запускает человек при приёмке (Manual check).

## Evidence

- `e2e/evidence/role-mcp.log` — вывод `node --import tsx --test e2e/role-mcp.test.js`.
- `e2e/evidence/role-mcp-frontmatter.log` — вывод mock-прогона во временном репозитории.
- Smoke: вывод `npm run smoke -- --only mcp` и `.agentflow-runs/smoke-*/events.jsonl`.

## Manual check

1. `npm run smoke -- --only mcp` на gigacode: все проверки MCP зелёные.
2. В целевом репозитории с настроенным MCP-сервером разрешить его spec-author
   (`roles.spec-author.mcp: ["mcp__<server>__*"]`) и запустить run: строка «сессия открыта» показывает
   сервер `connected`, вызовы видны в логе ACL как разрешённые.
3. `agentflow agents <run-id>` того же прогона: у spec-reviewer и code-reviewer MCP-вызовов нет.
