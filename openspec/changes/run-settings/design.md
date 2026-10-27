# Design

## Context

- `startRun` (`controller.ts`) получает `autoApprove`, `clarify`, `mock`, `inject` из флагов, проверяет
  intent и id change, затем создаёт каталог run, ветку и worktree и пишет `state.options`. Панель и
  режим мыши включаются позже, в `pipeline()`.
- Ревьюеры вызываются в пяти местах: `artifactRounds` и `holisticRounds` (spec-reviewer),
  `batchRounds` и `finalRounds` (code-reviewer), `runAcceptance` (acceptance-tester). Ветка PASS
  каждой петли уже знает, как закрыть петлю.
- `freezeProblems` требует `holisticPassed` с digest текущего пакета.
- Обсуждение решения (`talk`) получает список ролей петли. Диалог блокера и исчерпания строит его
  из стандартных пар ролей.
- `Human` работает через `PromptIO`: `select`, `input`, `tty`. Меню с галочками нет, но
  `@inquirer/checkbox` есть в `@inquirer/prompts` 8.

## Goals / Non-Goals

**Goals:**
- Одна точка правды о том, включена ли роль (`on(ctx, роль)`), — петли не читают `state.options`
  напрямую.
- Пропуск шага — отдельная ветка в начале шага, а не ветвление внутри логики ревью.
- Всё, что нужно unit-тестам (роли, обязательность, разбор флага, построение меню), — вне
  `controller.ts`.

**Non-Goals:**
- Подбор моделей и effort ролей в диалоге.
- Пропуск отдельных шагов роли (например, только финального ревью) — выключается роль целиком.

## Decisions

### 1. Модуль `run-settings.ts`

Константы `ROLES` (пять ролей в порядке конвейера), `REQUIRED` (spec-author) и
`SKIPPABLE`. Без implementer выключаются и code-reviewer с acceptance-tester (`normalizeSkip`, решение 8). Функции:
- `parseSkipRoles(arg)` — список из флага; неизвестная или обязательная роль — ошибка с перечнем
  допустимых;
- `settingsMenu(o)` — пункты меню: роли с `checked` и `disabled: 'обязательная роль'` у обязательных,
  затем «Уточнение intent» и «Автопилот» с начальным состоянием из флагов;
- `fromMenu(selected)` — `{ skip, clarify, autoApprove, untilReview, panel, mouse }`, где обязательные
  роли включены, даже если терминал их не вернул;
- `validateMenu(selected)` — два автопилота вместе — текст ошибки под меню;
- `skippedSteps(skip)` — тексты пропущенных шагов для лога и отчёта.

`controller.ts` уже содержит `ROLE_NAMES`. Он переходит на `ROLES` из модуля.

### 2. Меню с галочками в `Human`

`PromptIO` получает `checkbox(config)` (по умолчанию `@inquirer/prompts` `checkbox`), `Human` —
`checklist(title, items)`. Меню рисуется так же, как `select`: без панели и мыши, лог удержан.
Автопилот возвращает исходные галочки, хотя диалог при автопилоте и не открывается: метод должен
быть безопасен сам по себе.

Альтернатива — серия вопросов «включить code-reviewer?» через `select`: пять-семь шагов вместо одного
экрана, и не видно состава целиком.

### 3. Когда показывается диалог

В `startRun` после проверок intent и id change и до создания каталога run и ветки. Условия: stdin и
stdout — TTY, нет `--auto-approve`, `--auto-until-review` и `--skip-roles`. Галочки панели и мыши
задают `NO_PANEL` и `NO_MOUSE` этого запуска и в `state.json` не пишутся: `resume` берёт их из своих
флагов, как и раньше. Inquirer `checkbox` принимает `validate` — так меню не подтверждается с двумя
автопилотами. Иначе настройки берутся из флагов. Отказ от
диалога (Ctrl+C) прерывает запуск до создания ветки.

### 4. Состояние

`state.options.skip: string[]`. Старый `state.json` без поля читается как `[]` (в `RunStore.load`).
`options.autoApprove` и `options.clarify` уже есть: диалог только задаёт их значения. `resume`
настройки не спрашивает.

### 5. Пропуск шагов выключенной роли

`on(ctx, role)` = роль не в `options.skip`. Пропущенная петля пишется в сводку как
`store.loop(<петля>, <раунд>, 'SKIPPED', '<роль> выключена')`.

| Роль | Где | Что вместо шага |
| --- | --- | --- |
| spec-reviewer | `artifactRounds` после валидации и snapshot | сразу `artifactGate` — та же ветка, что после PASS ревьюера |
| spec-reviewer | `holisticLoop` | петли нет; `freezeProblems` не требует сквозного ревью |
| code-reviewer | `batchRounds` после коммита | ветка PASS: батч `done`, задачи отмечены |
| code-reviewer | `finalRounds` после полных гейтов и коммита | зелёные — `final.status: GATES_ONLY`; красные — находка гейта critical, раунд implementer, после лимита — `applyExhausted` |
| acceptance-tester | `stageAcceptance` | этапа нет, `acceptance.status: SKIPPED` |
| acceptance-tester | `finalRounds`, разбиение находок | все находки исправляет implementer |

Ветки PASS артефакта и батча выносятся в функции (`acceptReviewed`, `batchDone`), чтобы пропуск и
PASS закрывали петлю одним кодом.

Собеседники обсуждения в `talk` фильтруются по `on(ctx, …)`: выключенной роли нет в меню. Если не
осталось никого, пунктов обсуждения нет.

### 6. Финал без acceptance-tester и без code-reviewer

Промпт финального ревью при выключенном acceptance-tester вместо пути к отчёту получает строку
«acceptance-tester выключен в настройках run: отчёта acceptance нет, сценарии сверяй по коду и unit-тестам».
Диалог «Принять change?» пишет «acceptance не запускался (acceptance-tester выключен)» и
«финальное ревью: только полные гейты (code-reviewer выключен)».

### 7. Лог, панель и отчёт

В начале `pipeline()` — строка «выключены роли: … · пропускаются: …». В `state.json` и
`ACCEPTANCE.md` — раздел «Настройки прогона»: выключенные роли, пропущенные шаги, уточнение intent,
автопилот. Панель получает число включённых ролей.

### 8. Run только со спекой

Без implementer этапы apply, acceptance и final пропускаются в цикле `pipeline()` (`specRun`), а
человеческая приёмка и archive ведут себя иначе:
- диалог freeze — «Заморозить спеку?» с вариантом «Заморозить и завершить run»;
- приёмка: в режиме `--auto-until-review` — парковка, затем «Принять спеку?»; без режима — пропуск,
  спеку человек уже принял на freeze;
- archive не выполняется: `openspec archive` переносит дельты в `openspec/specs`, а без кода
  поведение не изменилось. Change остаётся активным, код — отдельным `run --change` после merge ветки.

Альтернатива — отдельный флаг `--spec-only`: та же семантика, что галочка implementer, но ещё одно
имя для одного выбора.

### Модули и проверка

Новый `run-settings.ts`. Меняются `controller.ts`, `human.ts`, `state.ts`, `report.ts`,
`context-builder.ts`, тесты в `agentflow.test.ts`, README и AGENTS.md.

Mock-прогоны в копии kit:
- `--auto-approve --skip-roles code-reviewer,acceptance-tester` — нет сессий code-reviewer и
  acceptance-tester, change архивирован, в отчёте раздел «Настройки прогона».
- `--auto-approve --skip-roles spec-reviewer` — нет сессий spec-reviewer, freeze проходит.
- `--skip-roles spec-author` — ошибка до создания ветки.
- `--auto-approve --skip-roles implementer` — freeze, без archive; после merge `run --change` доводит
  change до archive. С `--auto-until-review` — парковка на «Принять спеку?».
- `--auto-approve --skip-roles code-reviewer --inject kill-after:apply`, затем `resume` — финал без
  ревью кода.
- Диалог проверяется unit-тестами `Human.checklist` со сценарием `io` и функций `run-settings.ts`, в
  TTY — вручную.

## Risks / Trade-offs

- [Рубрика финального ревью требует проверку по отчёту acceptance, а отчёта нет → NOT_VERIFIED →
  BLOCKED] → строка в промпте объясняет отсутствие. Если ревьюер всё равно блокирует, открывается
  диалог блокера с переходом дальше.
- [Без spec-reviewer артефакт идёт к человеку без проверки рубрики] → это выбор человека. Валидация
  OpenSpec остаётся, отчёт называет пропущенное ревью.
- [Точки inject выключенной роли (`batch-revise:<id>`, `final-revise`, `blocked:final`) не
  срабатывают] → так и задумано, в README сказано, что inject выключенной роли не действует.
- [Терминал не возвращает недоступные галочки в ответе] → `fromMenu` включает обязательные роли
  всегда.

## Migration Plan

- Старые `state.json` без `options.skip` читаются как «все роли включены»: `resume` работает.
- Другие незаархивированные changes (`discuss-question`, `expand-thinking`, `dialog-proceed-discuss`)
  меняют другие требования, порядок архивирования не важен.
