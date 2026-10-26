# Design

## Context

Автопилот сейчас — один флаг `options.autoApprove`: `Human` с `auto: true` берёт рекомендацию в
`choose` и текст по умолчанию в `text`, а `askHuman` (`dialogs.ts`) выбирает «Всё равно перейти
дальше» только по точке `proceed:<петля>`. Waiver бывает рекомендован в двух местах
`controller.ts`: `artifactExhausted` (автор оспорил все находки) и исчерпание сквозного ревью
(те же находки повторяются). После freeze waiver нет, а apply-петли и блокеры автопилот уже
доводят до «Остановить» на третьем исчерпании. Значит, для режима достаточно трёх вещей: запрета
waiver и перехода дальше, парковки на приёмке и правила, когда автопилот выключается.

Решения человека в конвейере идут через `Human` из `makeCtx`, `Human` строится заново на каждый
`run` и `resume` — поэтому «выключить автопилот» значит не флаг в рантайме, а состояние в
`state.json`, по которому `makeCtx` строит `Human` при следующем resume.

## Goals / Non-Goals

**Goals:**
- Режим описывается состоянием run (`options.untilReview`, `handover`) и переживает resume.
- Логика режима — чистые функции в отдельном модуле: `controller.ts` не импортируется в тестах.
- `--auto-approve` и прогоны без флага ведут себя, как раньше, байт в байт в логе и отчёте.

**Non-Goals:**
- Общий механизм «припарковать любой диалог»: парковка только на приёмке, где stage
  `human-acceptance` состоит из одного диалога и повторяется без ролей.
- Перестройка `options` в перечисление режимов (это сделает `run-settings`, если понадобится).

## Decisions

### Модули

- **Новый `autopilot.ts`** — чистые функции:
  - `autopilotOn(options, handover)`: `autoApprove || (untilReview && !handover)`;
  - `untilReviewPick(recommended)`: для `waive` → `{ key: 'more', why: 'режим --auto-until-review: находки critical/major автопилот не снимает' }`, иначе `undefined`;
  - `checkModeFlags(autoApprove, untilReview)`: сообщение о несовместимости или `undefined`.
- **`state.ts`**: `options.untilReview?: boolean` (необязательное — старые `state.json` читаются),
  `handover?: { at: string; reason: string }`, статус `'awaiting-review'` в `RunState.status`.
- **`human.ts`**: `Human` получает третий параметр `strict` (автопилот режима): по нему отметка в логе
  `(--auto-until-review) →` вместо `(--auto-approve) →` и запрет перехода дальше в `askHuman`. Сам выбор waiver→more делает вызывающий через
  существующий `Choice.autoPick` — `Human` не знает ключей петель.
- **`dialogs.ts`**: в `askHuman` при `human.strict` точка `proceed:<петля>` проверяется, но
  переход не выбирается; лог: «режим --auto-until-review: переход дальше по proceed:<петля> пропущен».
  Точка считается сработавшей (`take`), чтобы не всплыть в следующем диалоге петли.
- **`controller.ts`**:
  - `main`/`startRun`: флаг `--auto-until-review`, `checkModeFlags` до создания ветки,
    `options.untilReview` в `state.json`, строка режима в начале лога;
  - `artifactExhausted` и исчерпание сквозного ревью: `autoPick: untilReview ? untilReviewPick(recommended) : undefined`;
    рекомендация для человека не меняется — она видна в логе и в отчёте;
  - `stageHumanAcceptance`: если `ctx.human.auto` и `untilReview` — бросить `Parked`;
  - `pipeline`: `Parked` → `status = 'awaiting-review'`, `handover = { reason: 'парковка на приёмке' }`,
    `ACCEPTANCE.md`, сводка петель, сообщение с отчётом, worktree, веткой и `agentflow resume`,
    `exitCode` не трогается (0). `Blocked` в режиме без `handover` → `handover = { reason: 'BLOCKED: …' }`;
  - `resumeRun`: для `awaiting-review` без TTY — сообщение «запусти resume в TTY», статус не
    меняется, `exitCode = 2`; иначе как сейчас (этап human-acceptance — первый незавершённый);
  - `makeCtx`: `new Human(autopilotOn(...), …, untilReview)`;
  - `runSettings`: меню настроек run не показывается при `--auto-until-review` — прогон без участия;
  - `showStatus`: ширина колонки статуса под `awaiting-review`.
- **`util.ts`**: класс `Parked` рядом с `Blocked`, но не наследник: места, которые ловят `Blocked`,
  не должны принять парковку за остановку.
- **`report.ts`**: шапка «ждёт ревью человека» для `awaiting-review`; раздел «Режим прогона» только
  при `options.untilReview`: решения автопилота — записи `decisions` до `handover.at` (все, если
  передачи нет), передача, открытые critical/major, waiver, `proceeded`.

### Почему так

- **Отдельный флаг, а не `--auto-approve --stop-at-review`.** Модификатор без `--auto-approve`
  бессмыслен, а два флага с одним смыслом путают. Один флаг — один режим; совместное указание —
  ошибка до ветки, а не тихий приоритет.
- **Waiver → ещё раунд, а не → стоп.** Автор, оспоривший находки, иногда сходится на следующем
  раунде с новым ревьюером; лимит уже защищает от бесконечности: третье исчерпание рекомендует
  «Остановить» (`exhaustedBefore`), и автопилот его берёт.
- **Подмена через `autoPick`, а не через `recommended`.** Человек после resume должен видеть
  честную рекомендацию ситуации; подмена касается только автопилота и пишется в лог с причиной.
- **Парковка — исключение до диалога, а не флаг в stage.** Так `pipeline` в одном месте делает
  то же, что для BLOCKED (отчёт, manifest, сводка, сброс панели в `finally`), но со своим статусом
  и кодом 0. Stage `human-acceptance` не попадает в `stagesDone`, поэтому resume открывает диалог,
  не запуская ролей.
- **Автопилот выключается по `handover`, а не по статусу.** Статус меняется на `running` в
  `resumeRun`; `handover` остаётся навсегда. Падение (`failed`) и `kill-after` не пишут `handover`:
  это сбои инфраструктуры, а не решение, что нужен человек.
- **Код выхода 0 при парковке.** Режим сделал то, что от него просили; скрипт отличает парковку от
  принятия по `agentflow status`. BLOCKED по-прежнему 2.

### Проверка mock-прогоном

В копии kit с `git init` и коммитом:

1. `npm run agentflow -- run tasks/01-slugify.md --mock --auto-until-review --inject all` — код 0,
   в сводке REVISE во всех петлях, `agentflow status` — `awaiting-review` на human-acceptance,
   в `ACCEPTANCE.md` раздел «Режим прогона», archive не выполнен, в логе отметки `(--auto-until-review)`.
2. `agentflow resume <run-id> </dev/null` — код 2, статус прежний.
3. `agentflow resume <run-id>` в TTY — сразу «Принять change?», Enter → archive, `accepted`.
4. `--inject batch-stuck:1,proceed:batch:1` — переход дальше пропущен, батч 1 не в `proceeded`.
5. `--inject kill-after:spec`, затем resume — apply идёт автопилотом, run паркуется.
6. `--auto-approve --auto-until-review` — ошибка, ветки нет.

Unit-тесты (`npm run test:agentflow`): функции `autopilot.ts`, `askHuman` со `strict`,
отметка в логе `Human`, раздел отчёта.

## Risks / Trade-offs

- [Автопилот проходит freeze на спеке, которую никто не читал] → приёмка показывает отчёт и
  решения автопилота; человек отклоняет change, если спека не та. Режим и задуман как «проверю всё
  в конце».
- [После BLOCKED в режиме resume требует TTY для любого решения] → это и есть передача человеку;
  без TTY run снова уходит в BLOCKED с указанием запустить в TTY, как без режима.
- [`run-settings` добавит галочку «Автопилот» в диалог настроек] → независимо от этого change:
  там галочка задаёт `autoApprove`; выбор режима в диалоге — отдельная правка после обоих changes.
- [Старый `state.json` без `untilReview`/`handover`] → поля необязательные, отсутствие = режим выключен.
