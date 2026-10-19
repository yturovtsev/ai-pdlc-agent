# agent-pdlc — контекст для агента

Kit конвейера spec-driven разработки на Qwen Code (корпоративный CLI — gigacode).
Детерминированный контроллер на TypeScript (`tools/agentflow/`) ведёт change через OpenSpec и
запускает пять ролей отдельными сессиями `@qwen-code/sdk@0.1.8`. Роли только предлагают
артефакты, код и вердикты; переходы, гейты, git и решения о прохождении принимает код.
Пользовательская документация — `README.md`, поведение — `openspec/specs/`.
Исходный дизайн: Claude Doc «Конвейер spec-driven разработки на Qwen Code — финальная конфигурация»
(https://claude.ai/artifact/B8DThSwNP1gabkXWe49Map). Отличия от него — README, раздел 7.

## Карта

| Путь | Что |
| --- | --- |
| `tools/agentflow/controller.ts` | этапы `STAGES`, петли (`artifactLoop`, `holisticLoop`, `batchLoop`, `stageFinal`), диалоги исчерпания, CLI (`run/resume/status/agents/changes/init`) |
| `roles.ts` | роли из файлов, сессия SDK на вызов (`runRole`), ACL `decideAcl` |
| `context-builder.ts` | промпты ролей, индекс требований `REQ-*/SCN-*`, батчи из задач OpenSpec |
| `review-validator.ts` | контракт ответа ревьюера и правила принятия (`decide`) |
| `human.ts` | меню стрелками: рекомендация `★` + обоснование; `--auto-approve` выбирает рекомендацию |
| `config.ts`, `policy.ts` | kit vs целевой репозиторий, слои настроек, `gateEnv` |
| `openspec.ts`, `git.ts`, `gates.ts`, `snapshot.ts`, `state.ts` | детерминированные узлы |
| `mock.ts`, `inject.ts`, `smoke.ts`, `agents.ts`, `report.ts` | mock-роли, fault injection, smoke CLI, список сессий, ACCEPTANCE.md |
| `bin/agentflow.mjs`, `bin/agentflow-gate` | глобальная команда (`npm link`); единственная shell-команда ролей |
| `.qwen/agents/*.md` | 5 ролей: model (id из `/model`), effort (наше поле), tools, maxTurns, промпт |
| `.agentflow/policy.yaml`, `rubrics/`, `review.schema.json` | лимиты, ACL, гейты; рубрики; контракт |
| `openspec/schemas/agentflow` | схема демо: spec-driven + test-plan |
| `src/ test/ e2e/ tasks/` | демо-библиотека и тестовые intent — цель конвейера в kit |

## Команды

```bash
npm run typecheck && npm run lint && npm run test:agentflow     # всегда после правок контроллера
npm run agentflow -- run tasks/01-slugify.md --mock --auto-approve --inject all   # все петли без моделей
npm run smoke                                                    # корпоративный CLI (нужны модели)
agentflow <run|resume|status|agents|changes|init|smoke>          # в любом репозитории после npm link
```

Mock-прогон создаёт ветку и worktree и коммитит в них: гоняй его в копии kit с `git init` или на
закоммиченном дереве. Mock-роли пишут только задачу slugify демо-проекта.

## Соглашения

- TS ESM без сборки (tsx), импорты с `.ts`, `strict` + `noUncheckedIndexedAccess`.
- Тексты для человека и комментарии — по-русски; комментарий объясняет «почему», их немного.
- Вывод — только через `log.ts` (он же пишет `events.jsonl`); состояние — через `RunStore` (атомарно).
- Решение человека — только `Human.select` с `recommended` и `rationale`.
- Новая петля: `store.loop(...)` на каждый раунд; после авто-лимита — диалог, а не обрыв.
- Пути в glob policy: `{change}`, `{acceptance}` раскрывает `expandGlob`.

## Неочевидные факты (проверено)

- SDK 0.1.8: в `query()` есть `effort`, `coreTools`, `includeDirectories`, `sessionId`/`resume`, `env`;
  `--auth-type` уходит, только если задан `authType`. stderr CLI доходит до callback только при
  `logLevel: 'debug'` — без этого причина «CLI exited with code 1» теряется.
- `effort` в плоский `reasoning_effort` CLI переводит только для хостов api.deepseek.com и z.ai;
  остальным уходит `reasoning: {effort}` → переключатель `qwen.effortViaSdk`.
- gigacode держит проектные файлы в `.gigacode/` (команды `.gigacode/commands/*.md`), а не в `.qwen/`.
  Модели в нём преднастроены, авторизация не нужна; id в ролях должны совпадать с `/model`.
- Frontmatter субагента: неизвестные поля игнорируются; `model: openai:<id>` тоже валиден.
- Инструменты: `read_file grep_search glob list_directory write_file edit run_shell_command`;
  алиасы в правилах `Read Edit Write Bash`; `read_many_files` нет. CLI читает `QWEN.md` и `AGENTS.md`.
- OpenSpec 1.14: `status --json` (артефакты, `applyRequires`), `instructions <id> --json`,
  `instructions apply --json` (задачи с `sourcePath`/`line`), `new change` без `--schema` берёт
  схему из `config.yaml`; `validate --strict` падает, пока в change нет дельт specs.
- OpenSpec ищет схемы в `openspec/schemas/<имя>/schema.yaml` проекта, в `$XDG_DATA_HOME/openspec/schemas`
  и в своей сборке; `Creating change … with schema 'spec-driven'` в спиннере `new change` — всегда дефолт,
  реальная схема из config.yaml. OpenSpec 1.13 не отдаёт `sourcePath` задач. CLI выбирает `ensureSchema`.
- Node 22.12: `node --test test/` каталог не принимает — нужен glob; `@inquirer/*` просит ≥22.13.
- `--auto-approve` + вечно красный гейт раньше зацикливался; теперь с 3-го исчерпания рекомендуется стоп.

## Решения (почему так)

- Оркестратор — код, а не LLM: вердикт привязан к snapshot, переходы детерминированы.
- Спеку пишет spec-author, ревьюит spec-reviewer, после PASS каждый артефакт принимает человек (решение 19.10.2026).
- Лимиты раундов не жёсткие: 3 авто, дальше решает человек. Waiver — только в фазе спеки.
- Route моделей не используются: модели из `/model`, effort через SDK.
- В чужом репозитории OpenSpec берётся как есть (схема, changes, версия CLI); kit даёт только роли,
  рубрики и policy по умолчанию.
- Прогресс задач — галочками в файле задач (digest их нормализует) и в `state.json`.

## Не сделано

Команды `/opsx:*` и `/spec-*` для gigacode; `.gigacode/settings.json`; контейнер, sandbox, сетевой
allowlist; хуки и MCP-источники требований; Claude Doc не обновлён под возврат spec-author.
На gigacode конвейер запущен у пользователя после правки id моделей; все петли целиком проверены
на mock-ролях (демо kit и чужой репозиторий со схемой spec-driven).
