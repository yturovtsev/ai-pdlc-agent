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

## Запуск в других репозиториях

Этот репозиторий — **kit**: код контроллера, роли, рубрики, policy по умолчанию и демо-проект.
Конвейер работает в любом локальном git-репозитории, из которого его запустили, и использует
**OpenSpec этого репозитория как есть**: схему из `openspec/config.yaml` (или `.openspec.yaml`
конкретного change), её артефакты, существующие changes, файл задач из `apply.tracks` схемы и
версию `openspec` из `node_modules` репозитория, если она там установлена. Если этот CLI (или CLI kit)
схему не видит, берётся `openspec` из PATH, который её видит, — так подхватываются встроенные схемы
корпоративной сборки. Схемы из `openspec/schemas/` переносятся в worktree, даже если они в `.gitignore`;
если схему не видит ни один CLI, run останавливается до создания change со списком того, что видит каждый.

```bash
# один раз, в kit
npm install && npm link          # глобальная команда agentflow (или: alias agentflow="node <kit>/tools/agentflow/bin/agentflow.mjs")

# в целевом репозитории
cd ~/work/other-repo
agentflow init                   # .agentflow/policy.yaml (гейты проекта), .gitignore; существующий openspec/ не трогает,
                                 # если его нет — openspec init со схемой по умолчанию (--agentflow-schema добавит схему kit)
#   проверь gates.ops и acceptance в .agentflow/policy.yaml, закоммить .agentflow и .gitignore
agentflow smoke                  # CLI, модели, ACL — в этом репозитории
agentflow changes                # changes репозитория: схема, задачи, прогоны
agentflow run --change <id>      # довести существующий change
agentflow run intent.md          # новый change по intent (схема — по умолчанию репозитория)
```

| Что | Откуда берётся |
| --- | --- |
| схема, артефакты, changes, specs | `openspec/` целевого репозитория |
| `openspec` CLI | `node_modules/.bin/openspec` репозитория, иначе kit |
| гейты (`lint`, `unit`, `e2e`) | `gates.ops` в `.agentflow/policy.yaml` репозитория — команды проекта |
| остальная policy | policy kit + `.agentflow/policy.yaml` репозитория (объекты сливаются, списки заменяются) |
| роли | `.agentflow/agents/<роль>.md` репозитория, иначе `.qwen/agents/` kit |
| рубрики | `.agentflow/rubrics/<id артефакта>.md` репозитория, иначе kit; для артефакта без рубрики — `artifact.md` |
| прогоны | `.agentflow-runs/` в репозитории (в git — только `ACCEPTANCE.md`) |

**Существующий change.** Незакоммиченное состояние `openspec/` (сам change, config, схемы)
переносится в worktree. Уже написанные артефакты сначала идут на ревью (spec-author их не
переписывает), недостающие пишет spec-author, уточнение intent пропускается. Задачи, отмеченные
`[x]`, считаются выполненными; принятый батч отмечается в файле задач так же — как принято в OpenSpec.

**Схема без test-plan** (например, `spec-driven`): acceptance-tester строит проверки из сценариев specs.

Роли вызывают гейты одинаково в любом репозитории — `agentflow-gate <операция>`; контроллер кладёт
эту команду в PATH сессий и передаёт ей команды из `gates.ops`. Worktree лежит внутри репозитория,
поэтому `node_modules` основного дерева находятся автоматически. Если инструменты проекта сканируют
всё дерево (tsc `include`, jest), добавь им в исключения `.agentflow-runs/`.

## 2. Настройка (два места)

1. **CLI.** В `.agentflow/policy.yaml` → `qwen.executable` — имя корпоративного CLI в PATH или
   абсолютный путь (по умолчанию `qwen`). Можно перекрыть без правки файла:
   `export AGENTFLOW_QWEN_CLI=/path/to/qwen`.
2. **Модели.** В `.qwen/agents/*.md` поле `model:` — id ровно как в списке `/model` корпоративного
   CLI. Ни route, ни ключей, ни `~/.qwen/settings.json` настраивать не нужно.

Effort берётся из поля `effort:` файла роли и передаётся в сессию через `query({ effort })` —
SDK 0.1.8 это поддерживает. Если модель или шлюз отвечают ошибкой на поле reasoning,
поставь `qwen.effortViaSdk: false`.

Один запрос к модели CLI ждёт 120 с, а на effort `max` ответ бывает дольше. Поэтому kit поднимает таймаут
до `qwen.apiTimeoutSeconds: 600`: значение уходит в сессию как `QWEN_CODE_API_TIMEOUT_MS`, `0` оставляет
дефолт CLI. Сбой API (таймаут, обрыв, 4xx/5xx) CLI отдаёт текстом `[API Error: …]` в успешном ответе;
контроллер считает это ошибкой шага и повторяет его новой сессией.

**MCP-инструменты роли.** Серверы настраиваются в самом CLI (для gigacode — `.gigacode/settings.json`
или пользовательские настройки), а разрешает их роли только policy. Перечислить `mcp__…` в `tools:`
файла роли недостаточно: CLI на этот список для MCP не смотрит, контроллер при старте предупредит.

```yaml
# .agentflow/policy.yaml
roles:
  spec-author:
    mcp: ["mcp__jira__*"]        # mcp__<server>__<tool>, * допустим; нет ключа или [] — MCP запрещён
```

- Роль без `mcp` и любой шаг только на чтение (уточнения) не могут выполнить ни одного
  MCP-инструмента: CLI отклоняет вызов по правилу `mcp__*`, даже если у сервера `trust: true` или
  у инструмента `readOnlyHint`.
- Роль с `mcp` подключает только серверы, названные в шаблонах (`mcp__jira__…` → `jira`).
  Шаблон без явного сервера (`mcp__*`) подключает все серверы CLI.
- Инструменты, на которые CLI спрашивает разрешение, проходят ACL (`✓/✗ ACL mcp__…`). Инструменты
  с `readOnlyHint` и с сервера `trust: true` CLI выполняет сам, поэтому после роли контроллер сверяет
  выполненные MCP-вызовы с `mcp`, и вызов вне списка переводит run в BLOCKED. Чтобы этого не было,
  разрешай сервер целиком (`mcp__jira__*`) или ставь серверу `trust: false`.
- Имя инструмента и статус серверов видны в строке «сессия открыта» (`MCP: jira connected,
  инструментов 3`) и в init-сообщении в `events.jsonl`.

## 3. Проверка по шагам

```bash
npm run test:agentflow     # офлайн: контракт ревью, правила принятия, ACL, digest — без моделей
npm run agentflow -- run tasks/01-slugify.md --mock --auto-approve --inject all
                           # весь конвейер на mock-ролях: все петли, гейты, git, archive — без моделей
npm run smoke              # корпоративный CLI: модели из /model, effort, tool calls в thinking mode,
                           # ревьюер не пишет, ACL implementer, resume, MCP по policy
```

В kit команды доступны и как `npm run agentflow -- <команда>` / `npm run smoke`, в любом репозитории —
как `agentflow <команда>` / `agentflow smoke`.

Если smoke пишет `No auth type is selected`, укажи `qwen.authType` в policy (тип из настроек CLI,
обычно `openai`). Результат smoke — в `.agentflow-runs/smoke-*/smoke.json`.

## 4. Боевой прогон

```bash
npm run agentflow -- run tasks/01-slugify.md                 # интерактивно: уточнения, согласование, приёмка
npm run agentflow -- run tasks/01-slugify.md --inject all    # то же, но каждая петля принудительно проходит REVISE
npm run agentflow -- run tasks/03-incomplete.md              # неполный intent: ожидаются вопросы человеку или BLOCKED, а не догадки
npm run agentflow -- run "Добавь функцию truncate(text, n)" --change add-truncate
npm run agentflow -- status [<run-id>]                       # состояние и сводка пройденных петель
npm run agentflow -- agents [<run-id>]                       # список субагентов: роль, сессия, модель из ответа API
npm run agentflow -- resume <run-id>                         # продолжить после BLOCKED, сбоя или kill
```

### Где решаешь ты

Все решения — выбор стрелками ↑↓ и Enter. Рекомендуемый вариант стоит первым, помечен `★` и
подсвечен, под меню — его обоснование. `--auto-approve` выбирает рекомендуемое за тебя.

1. **Уточнения intent** — вопросы spec-author с вариантами ответа.
2. **Твоё ревью каждого артефакта.** spec-author и spec-reviewer доводят артефакт до PASS, затем
   контроллер задаёт отложенные вопросы по нему и предлагает: принять и перейти к следующему,
   вернуть автору с замечанием, исправить самому (ревьюер перепроверит), показать артефакт, остановить.
3. **Лимит автоматических раундов исчерпан** (3 в артефакте, сквозном ревью, батче; 2 исправления
   в финале) — вместо обрыва диалог: ещё раунд, указание автору/implementer, исправлю сам, новый
   implementer, снять находки с причиной (waiver, только в спеке), вернуться к спеке, остановить.
   Рекомендация зависит от ситуации: те же находки повторяются → указание; находки меняются →
   ещё раунд; автор оспорил всё → waiver; гейты красные → свежий implementer.
4. **Freeze** — проходит, только если каждый артефакт принят тобой на текущей редакции (или его
   находки сняты waiver), сквозное ревью PASS и `openspec validate --strict` чист. Правка уже
   принятого артефакта отправляет его и всё ниже по графу на повторное ревью.
5. **Приёмка** — принять (→ `openspec archive`) или отклонить.

Waiver и все решения пишутся в `state.json` (`decisions`) и в `ACCEPTANCE.md`.

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
`✓/✗ ACL` — решение контроллера по записи, shell и MCP, `●` — гейт, `◆` — вердикт и куда дальше,
`⚡` — fault injection. В конце печатается сводка петель; она же есть в `ACCEPTANCE.md`.

Внизу терминала во время `run` и `resume` закреплена панель статуса, лог прокручивается над ней:

```
▶ implementer 02:14 · батч 1 · deepseek-flash · effort max · новая сессия · инстр. 12 · запуск 7 · ролей 5
⏱ 18:40 · петля «task batch 1 «Функция slugify»» 1/3 · ФАЗА APPLY · change add-slugify · run 20261020-…
```

В первой строке — текущий субагент: сколько он работает (время растёт каждую секунду, даже когда
модель молчит), над чем работает (`пишет design.md`, `ревью design`, `сквозное ревью change`, `батч 2`,
`ревью батча 2`, `acceptance-тесты`, `финальное ревью`), модель, effort, новая или продолженная сессия, сколько вызвал инструментов, номер
запуска в run (resume продолжает счёт) и число ролей. Пока субагента нет, в этой строке
`⚙ контроллер` и его последний шаг: гейт, вердикт, решение человека. Вторая строка — время команды,
петля с раундом, этап, change и run id. Длинные строки обрезаются по ширине окна.

На время диалога панель убирается, после ответа появляется снова. Она не включается без TTY
(вывод в файл или pipe), в окне ниже 10 строк или уже 40 колонок, с `--no-panel` и при
`AGENTFLOW_NO_PANEL=1`. При выходе, включая Ctrl+C и BLOCKED, терминал возвращается в обычное
состояние. Только если процесс убит `kill -9`, область прокрутки остаётся: верни её `reset` или
`printf '\e[r'`.

## 5. Петли конвейера

| Петля | Лимит | Где в коде |
| --- | --- | --- |
| уточнение intent → ответы человека | — | `stageClarify` |
| артефакт: spec-author → валидация → snapshot → spec-reviewer, REVISE | 3 авто, дальше диалог | `artifactLoop`, `artifactExhausted` |
| твоё ревью артефакта: принять / вернуть / исправлю сам → снова ревью | человек | `artifactGate` |
| битый JSON / нарушение контракта → новый экземпляр ревьюера | 2 повтора, дальше диалог | `callReviewer`, `infraExhausted` |
| сквозное ревью → исправление артефактов → переревью downstream | 3 авто, дальше диалог | `holisticLoop`, `reaccept` |
| согласование и freeze: условия, вопросы, возврат артефакта | человек | `stageApproval`, `freezeProblems` |
| freeze: digest спеки, сверка перед каждым шагом apply | — | `stageFreeze`, `verifyFreeze` |
| гейты красные → тот же implementer | 3 попытки на вызов | `implementWithGates` |
| батч: реализация → гейты → коммит → ревью кода, REVISE (с 3-го раунда — новый implementer) | 3 авто, дальше диалог | `batchLoop`, `applyExhausted` |
| acceptance по замороженной спеке | — | `runAcceptance` |
| полные гейты → финальное ревью → исправления implementer / acceptance-tester | 2 авто, дальше диалог | `stageFinal`, `applyExhausted` |
| отчёт → приёмка → `openspec archive` | человек | `stageReport`, `stageHumanAcceptance`, `stageArchive` |

`--inject all` включает точки: `review-bad-json`, `artifact-revise:proposal`, `holistic-revise`,
`gate-red:1`, `batch-revise:1`, `final-revise` (срабатывают один раз) и `artifact-stuck:specs`,
`batch-stuck:2` (одна и та же находка все автоматические раунды — показывают диалог исчерпания).
Отдельно: `--inject kill-after:<этап>` убивает контроллер после этапа (проверка resume).

BLOCKED (твой выбор «остановить», `needsHuman` в apply, спор о безопасности, изменённая спека,
нужен человек без TTY) останавливает run; причина — в `state.json` и `ACCEPTANCE.md`.

## 6. Что где лежит

```text
AGENTS.md                    контекст для агента: карта, команды, соглашения, неочевидные факты, решения
.qwen/agents/*.md            пять ролей — единственный источник истины (model, effort, tools, maxTurns, промпт)
.qwen/settings.json          общие запреты для интерактивного qwen
.agentflow/policy.yaml       CLI, лимиты петель, ACL ролей, гейты, denyAll
.agentflow/rubrics/*.md      рубрики артефактов и ревью; обязательные checks — в разделе «Обязательные проверки»
.agentflow/review.schema.json  контракт ответа ревьюера
openspec/                    config.yaml (context/rules для артефактов), schemas/agentflow (spec-driven + test-plan),
                             specs/ — базовые спеки конвейера (7 capability), changes/
tools/agentflow/             controller.ts roles.ts config.ts context-builder.ts review-validator.ts
                             snapshot.ts gates.ts openspec.ts git.ts state.ts human.ts inject.ts report.ts
                             agents.ts mock.ts smoke.ts agentflow.test.ts
                             run.sh — гейты демо-проекта; bin/agentflow.mjs, bin/agentflow-gate
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
- В демо-проекте kit — схема `openspec/schemas/agentflow` (`spec-driven` плюс `test-plan`); в других репозиториях — их собственная схема.
- Запуск локальный: git worktree без контейнера, sandbox и сетевого allowlist. Fail-closed граница — ACL
  контроллера в `canUseTool` плюс сверка изменённых путей после каждой роли.
- Лимитов бюджета и времени нет (`roleTimeoutMinutes: 0`); расход пишется в `state.json` для информации.
- Гейты демо-проекта — `lint` (eslint), `unit` и `e2e` (`node --test`) в `run.sh`; другие репозитории задают свои в `gates.ops`.
- Хуки Qwen Code и MCP-источники требований не подключены.
- Спеку пишет spec-author, а не ты: ты ревьюишь каждый артефакт после PASS ревьюера и решаешь по
  исчерпанным раундам. Команды `/opsx:*`, `/spec-review`, `/spec-waive`, `/spec-approve` не нужны —
  те же решения принимаются в диалогах контроллера.
- GigaCode читает проектные настройки из `.gigacode/`, а не из `.qwen/`: запреты `.qwen/settings.json`
  для интерактивной сессии gigacode скопируй в `.gigacode/settings.json`. Контроллеру это не нужно —
  он сам читает `.qwen/agents/` и применяет ACL.
