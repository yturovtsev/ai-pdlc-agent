# Design

## Context

OpenSpec ищет схему в трёх местах: `openspec/schemas/<имя>/schema.yaml` проекта,
`$XDG_DATA_HOME/openspec/schemas` (по умолчанию `~/.local/share/openspec/schemas`) и каталог `schemas/`
своей сборки. Контроллер запускает его в worktree, построенном от HEAD, и до изменения брал первый
найденный CLI: `node_modules` репозитория → kit → PATH. Спиннер `new change` всегда печатает схему по
умолчанию (`spec-driven`), поэтому текст ошибки сбивал с толку. Мотивация — proposal.md, «Why».

## Goals / Non-Goals

**Goals:**
- Схема, которую видит пользователь в основном дереве, видна и в worktree.
- Ошибка о схеме возникает до создания change и state прогона и объясняет, что видит каждый CLI.

**Non-Goals:**
- Подгонка контроллера под OpenSpec < 1.14 (нет `sourcePath` у задач apply).
- Собственный резолвер схем: решает сам OpenSpec (`openspec schemas --json`).

## Decisions

- **Перенос `openspec/config.yaml` и `openspec/schemas/` целиком, `force: false`.** Закоммиченные и
  незакоммиченные файлы уже есть в worktree (HEAD + перенос по `git status`), так что копия добавляет
  только то, чего git не видит. `git add -A` при коммитах уважает `.gitignore`, игнорируемые схемы в
  ветку не попадают. Альтернатива — `git status --ignored`: сложнее и даёт тот же результат.
- **Выбор CLI по видимости схемы, порядок по умолчанию не меняется** (`openspec.ts`, `ensureSchema`).
  Сначала CLI репозитория или kit (версия, под которую написан контроллер), PATH — только если они схему
  не видят. Альтернатива «PATH раньше kit» отвергнута: на машине разработки в PATH стоит OpenSpec 1.13,
  с которым apply падает.
- **Определение имени схемы — как у OpenSpec:** явная (`policy.openspec.schema`) → `.openspec.yaml`
  change → `config.yaml` → `spec-driven`. Проверка — по `openspec schemas --json` каждого кандидата.
- **CLI в `state.versions.openspecBin`** (`state.ts`, `controller.ts`): `resume` не должен заново
  выбирать CLI и попадать в другую сборку. Поле необязательное — старые state.json читаются.
- **Проверка до `store.save()`** (`controller.ts`, `startRun`): иначе остался бы state без change, и
  `resume` упал бы в `status`, не вызывая `new change`.
- **`openspec.schema: ""` в policy kit:** у kit схема уже в `openspec/config.yaml`; непустое значение
  в слое kit перебивает схему каждого репозитория без своей policy.

Проверка mock-прогоном: в копии kit (`git init`) `run tasks/01-slugify.md --mock --auto-approve
--inject all` доходит до archive со схемой `agentflow` из config; во временном репозитории с
кастомной схемой лог показывает `схема OpenSpec: <кастомная>`.

## Risks / Trade-offs

- [CLI из PATH видит схему, но старше 1.14] → apply падает с явным «нужен OpenSpec ≥ 1.14» вместо
  TypeError; фаза спеки при этом работает.
- [Несколько CLI видят схему по-разному (разные версии схемы)] → берётся первый в порядке по умолчанию,
  путь CLI печатается в логе и пишется в manifest.
- [Каталог schemas большой] → копируется один раз на run; на практике это несколько файлов.

## Migration Plan

Действий не нужно. Репозиторий, полагавшийся на `schema: agentflow` из policy kit без своего config,
должен прописать `schema: agentflow` в `openspec/config.yaml` (`agentflow init --agentflow-schema`
подсказывает это).
