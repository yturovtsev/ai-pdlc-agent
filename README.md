# agent-pdlc — конвейер spec-driven разработки на Qwen Code

Реализация документа «Конвейер spec-driven разработки на Qwen Code — финальная конфигурация».
Оркестратор — детерминированный контроллер на TypeScript (`tools/agentflow/controller.ts`).
Пять ролей-субагентов запускаются как отдельные сессии `query()` из `@qwen-code/sdk@0.1.8`
через корпоративный CLI. Роли только предлагают артефакты, код и вердикты; переходы, гейты,
git и решения о прохождении принимает контроллер.

| Роль | Модель (`/model`) | effort | Что делает |
| --- | --- | --- | --- |
| spec-author | `qwen3.8-flash` | xhigh | пишет один артефакт OpenSpec за вызов |
| spec-reviewer | `deepseek-flash` | max | ревью артефакта и сквозное ревью, только чтение |
| implementer | `deepseek-flash` | max | один task batch: тест из сценария, затем код |
| code-reviewer | `glm-5.3-flash` | max | ревью батча и финальное ревью трассировки, только чтение |
| acceptance-tester | `qwen3.8-flash` | xhigh | e2e-тесты по сценариям спеки и evidence |

## 1. Перенос на корпоративную машину

Скопируй каталог целиком, **кроме** `node_modules/` и `.agentflow-runs/`. Потом:

```bash
cd agent-pdlc
npm install                      # Node >= 22.13; @qwen-code/sdk 0.1.8, @fission-ai/openspec 1.14.0
git init && git add -A && git commit -m "agentflow: init"   # контроллер работает в git worktree
```

## 2. Настройка (два места)

1. **CLI.** В `.agentflow/policy.yaml` → `qwen.executable` — имя корпоративного CLI в PATH или
   абсолютный путь (по умолчанию `qwen`). Можно перекрыть без правки файла:
   `export AGENTFLOW_QWEN_CLI=/path/to/qwen`.
2. **Модели.** В `.qwen/agents/*.md` поле `model:` — id ровно как в списке `/model` корпоративного
   CLI. Ни route, ни ключей, ни `~/.qwen/settings.json` настраивать не нужно.

Effort берётся из поля `effort:` файла роли и передаётся в сессию через `query({ effort })` —
SDK 0.1.8 это поддерживает. Если модель или шлюз отвечают ошибкой на поле reasoning,
поставь `qwen.effortViaSdk: false`.

## 3. Проверка по шагам

```bash
npm run test:agentflow     # офлайн: контракт ревью, правила принятия, ACL, digest — без моделей
npm run agentflow -- run tasks/01-slugify.md --mock --auto-approve --inject all
                           # весь конвейер на mock-ролях: все петли, гейты, git, archive — без моделей
npm run smoke              # корпоративный CLI: модели из /model, effort, tool calls в thinking mode,
                           # ревьюер не пишет, ACL implementer, resume
```

Если smoke пишет `No auth type is selected`, укажи `qwen.authType` в policy (тип из настроек CLI,
обычно `openai`). Результат smoke — в `.agentflow-runs/smoke-*/smoke.json`.

## 4. Боевой прогон

```bash
npm run agentflow -- run tasks/01-slugify.md                 # интерактивно: уточнения, согласование, приёмка
npm run agentflow -- run tasks/01-slugify.md --inject all    # то же, но каждая петля принудительно проходит REVISE
npm run agentflow -- run tasks/03-incomplete.md              # неполный intent: ожидаются вопросы человеку или BLOCKED, а не догадки
npm run agentflow -- run "Добавь функцию truncate(text, n)" --change add-truncate
npm run agentflow -- status [<run-id>]                       # состояние и сводка пройденных петель
npm run agentflow -- resume <run-id>                         # продолжить после BLOCKED, сбоя или kill
```

Ты участвуешь в трёх местах: ответы на уточнения intent, согласование спеки с пакетом вопросов,
ручная приёмка. `--auto-approve` отвечает за тебя (для прогонов без участия).

### Что видно в консоли

```
┌─ петля «артефакт proposal» · раунд 1/3
│ ▶ субагент spec-author [модель qwen3.8-flash · effort xhigh · новая сессия 54c7b088]
│   spec-author │ → read_file src/strings.js
│   spec-author │ ✓ ACL write_file openspec/changes/add-slugify/proposal.md
│ ■ spec-author завершил · 7 ходов · 41 с · модель из ответа API: qwen3.8-flash
│ ⚙ детерминированная валидация пройдена (файлы, openspec status/validate, формат)
│ ⚙ snapshot артефакта 5cd34c3fd84e
│ ▶ субагент spec-reviewer [модель deepseek-flash · effort max · новая сессия cd7b08a4]
│ ◆ вердикт REVISE · critical 0 · major 1 · minor 0 · nit 0 → назад к spec-author, раунд 2
└─ REVISE
```

`▶` — запуск субагента (модель, effort, новая или продолженная сессия), `→` — вызов инструмента,
`✓/✗ ACL` — решение контроллера по записи и shell, `●` — гейт, `◆` — вердикт и куда дальше,
`⚡` — fault injection. В конце печатается сводка петель; она же есть в `ACCEPTANCE.md`.

## 5. Петли конвейера

| Петля | Лимит | Где в коде |
| --- | --- | --- |
| уточнение intent → ответы человека | — | `stageClarify` |
| артефакт: генерация → валидация → snapshot → ревью, REVISE | 3 раунда | `artifactLoop` |
| битый JSON / нарушение контракта → новый экземпляр ревьюера | 2 повтора | `callReviewer` |
| сквозное ревью → исправление артефактов → переревью downstream | 3 раунда | `holisticLoop`, `reaccept` |
| согласование: вопросы и замечания → петли артефактов → сквозное ревью | человек | `stageApproval` |
| freeze: digest спеки, сверка перед каждым шагом apply | — | `stageFreeze`, `verifyFreeze` |
| гейты красные → тот же implementer | 3 попытки на вызов | `implementWithGates` |
| батч: реализация → гейты → коммит → ревью кода, REVISE (с 3-го раунда — новый implementer) | 3 раунда | `batchLoop` |
| acceptance по замороженной спеке | — | `runAcceptance` |
| полные гейты → финальное ревью → исправления implementer / acceptance-tester | 2 раунда | `stageFinal` |
| отчёт → приёмка → `openspec archive` | человек | `stageReport`, `stageHumanAcceptance`, `stageArchive` |

`--inject all` включает точки: `review-bad-json`, `artifact-revise:proposal`, `holistic-revise`,
`gate-red:1`, `batch-revise:1`, `final-revise`. Отдельно: `--inject kill-after:<этап>`
убивает контроллер после этапа (проверка resume). Каждая точка срабатывает один раз.

BLOCKED (лимит, `needsHuman` в apply, спор о безопасности, изменённая спека, нужен человек без TTY)
останавливает run; причина — в `state.json` и `ACCEPTANCE.md`.

## 6. Что где лежит

```text
.qwen/agents/*.md            пять ролей — единственный источник истины (model, effort, tools, maxTurns, промпт)
.qwen/settings.json          общие запреты для интерактивного qwen
.agentflow/policy.yaml       CLI, лимиты петель, ACL ролей, гейты, denyAll
.agentflow/rubrics/*.md      рубрики артефактов и ревью; обязательные checks — в разделе «Обязательные проверки»
.agentflow/review.schema.json  контракт ответа ревьюера
openspec/                    config.yaml, schemas/agentflow (spec-driven + test-plan), specs/, changes/
tools/agentflow/             controller.ts roles.ts context-builder.ts review-validator.ts snapshot.ts
                             gates.ts run.sh openspec.ts git.ts state.ts human.ts inject.ts report.ts
                             mock.ts smoke.ts agentflow.test.ts
src/ test/ e2e/              демо-библиотека, на которой решаются тестовые задачи
tasks/                       тестовые intent: 01-slugify, 02-parse-duration, 03-incomplete
.agentflow-runs/<run-id>/    manifest.yaml state.json events.jsonl contexts/ reviews/ gates/ evidence/
                             ACCEPTANCE.md worktree/ (ветка agentflow/<change>)
```

`events.jsonl` — полный журнал: каждое сообщение каждой SDK-сессии, решения ACL, гейты.
`contexts/` — промпт каждого вызова роли, diff батчей, отчёт acceptance.
Merge ветки — вне конвейера, после твоей приёмки (команды в конце `ACCEPTANCE.md`).

## 7. Отличия от документа

- Route моделей, `envKey` и `extra_body` не используются: модели берутся из `/model` корпоративного CLI,
  effort передаётся через `query({ effort })` (SDK 0.1.8), без доработки форка.
- Вместо корпоративной схемы — проектная `openspec/schemas/agentflow`: `spec-driven` плюс `test-plan`.
- Запуск локальный: git worktree без контейнера, sandbox и сетевого allowlist. Fail-closed граница — ACL
  контроллера в `canUseTool` плюс сверка изменённых путей после каждой роли.
- Лимитов бюджета и времени нет (`roleTimeoutMinutes: 0`); расход пишется в `state.json` для информации.
- Гейты — только `lint` (eslint), `unit` и `e2e` (`node --test`) в `run.sh`.
- Хуки Qwen Code и MCP-источники требований не подключены.
