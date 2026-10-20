# role-sessions Specification

## Purpose
Каждая роль конвейера запускается отдельной сессией SDK с параметрами из своего файла, а границы её полномочий обеспечивает контроллер, а не модель.

## Requirements

### Requirement: Источник роли
Контроллер SHALL брать роль из `.agentflow/agents/<роль>.md` целевого репозитория, иначе из `.qwen/agents/` kit; model, effort, tools и maxTurns — из frontmatter, промпт — из тела файла.

#### Scenario: Роль переопределена в репозитории
- **WHEN** в целевом репозитории есть `.agentflow/agents/implementer.md`
- **THEN** implementer запускается с этим файлом, остальные роли — с файлами kit

### Requirement: Отдельная сессия на вызов
Контроллер SHALL запускать каждый вызов роли отдельной сессией `query()` через CLI из `qwen.executable` (или `AGENTFLOW_QWEN_CLI`), регистрируя только инструменты роли; ревьюер каждого раунда — новая сессия, implementer в раунде исправлений продолжает свою через resume.

#### Scenario: Ревьюер не может писать
- **WHEN** spec-reviewer пытается создать файл
- **THEN** инструмента записи у его сессии нет и файл не появляется

### Requirement: ACL по умолчанию запрещает
Контроллер SHALL разрешать роли запись только по glob `write`/`denyWrite` её policy в пределах worktree, shell — только `agentflow-gate <операция>` из списка роли, MCP-инструмент — только по шаблонам `mcp` её policy; любой другой вызов отклоняется.

#### Scenario: Запись в спеку
- **WHEN** implementer пишет файл в `openspec/`
- **THEN** `canUseTool` отклоняет вызов, в логе отмечается отказ ACL

#### Scenario: Составная команда
- **WHEN** роль вызывает `agentflow-gate lint && git push`
- **THEN** вызов отклоняется

#### Scenario: Разрешённый MCP-инструмент
- **WHEN** в policy spec-author `mcp: ["mcp__jira__*"]` и spec-author вызывает `mcp__jira__get_issue`
- **THEN** вызов выполняется, в логе ACL отмечено разрешение с совпавшим шаблоном

#### Scenario: MCP-инструмент вне allowlist
- **WHEN** в policy spec-author `mcp: ["mcp__jira__get_issue"]` и spec-author вызывает `mcp__jira__create_issue`, на который CLI запрашивает разрешение
- **THEN** `canUseTool` отклоняет вызов, причина в логе называет ключ `roles.spec-author.mcp`

### Requirement: Сверка изменений после роли
После каждой пишущей роли контроллер SHALL сверять изменённые файлы worktree с её ACL и переводить run в BLOCKED при нарушении.

#### Scenario: Файл вне полномочий
- **WHEN** после acceptance-tester изменён файл вне каталога acceptance-тестов
- **THEN** run переходит в BLOCKED со списком файлов

### Requirement: Учёт моделей и сбоев CLI
Контроллер SHALL записывать фактическую модель из ответов API и расход по ролям; при падении CLI — показывать команду запуска и хвост stderr, повторять до `infraRetries` и затем спрашивать человека.

#### Scenario: CLI завершился без ответа
- **WHEN** CLI роли завершается с кодом 1
- **THEN** в консоли видны команда запуска и stderr, после серии попыток открывается диалог «повторить / остановить»

### Requirement: MCP-инструменты по policy
Контроллер SHALL давать MCP-инструменты только роли с непустым `mcp` в policy и только в шагах, где роли разрешена запись. В остальных сессиях MCP-вызов SHALL отклоняться до исполнения, даже если CLI выполнил бы его без запроса разрешения (`trust: true` сервера, `readOnlyHint`). Роль с непустым `mcp` SHALL подключать только серверы, названные в её шаблонах, если шаблон называет сервер явно. После роли контроллер SHALL сверять её MCP-вызовы с `mcp` и переводить run в BLOCKED при вызове вне allowlist.

#### Scenario: Роль без mcp не вызывает MCP
- **WHEN** в CLI подключён MCP-сервер с инструментом `readOnlyHint`, а у spec-reviewer в policy нет `mcp`
- **THEN** вызов этого инструмента spec-reviewer отклоняется до исполнения, и инструмент не выполняется

#### Scenario: Шаг только на чтение
- **WHEN** у spec-author `mcp: ["mcp__jira__*"]` и идёт шаг уточнений (только чтение)
- **THEN** MCP-вызовы его сессии отклоняются до исполнения

#### Scenario: Только названные серверы
- **WHEN** в CLI подключены серверы `jira` и `confluence`, а у spec-author `mcp: ["mcp__jira__*"]`
- **THEN** сервер `confluence` к сессии spec-author не подключается и его инструменты не выполняются, инструменты `jira` доступны

#### Scenario: MCP-вызов в обход ACL
- **WHEN** у spec-author `mcp: ["mcp__jira__get_issue"]`, а CLI без запроса разрешения выполнил `mcp__jira__search` (сервер с `trust: true`)
- **THEN** после роли run переходит в BLOCKED со списком MCP-вызовов вне allowlist

### Requirement: Диагностика MCP роли
Контроллер SHALL показывать при открытии сессии подключённые MCP-серверы и их статус по init-сообщению CLI. Если `tools:` роли содержит `mcp__…`, которых не разрешает её `mcp` в policy, контроллер SHALL предупреждать при загрузке ролей и называть ключ policy, где их разрешить.

#### Scenario: MCP только во frontmatter
- **WHEN** в `tools:` spec-author указан `mcp__jira__get_issue`, а в policy у spec-author нет `mcp`
- **THEN** при старте run в логе предупреждение с именем инструмента и ключом `roles.spec-author.mcp`

#### Scenario: Сервер не подключился
- **WHEN** MCP-сервер из шаблона роли не настроен в CLI или упал при старте
- **THEN** в строке открытия сессии видно, что сервера нет или его статус не `connected`
