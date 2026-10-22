# Test Plan

## Scope

Capability `pipeline-orchestration`:

- «Видимость работы субагентов» (MODIFIED): «Список субагентов» (регрессия), «Время событий роли»,
  «Сводка отказов в итоге роли», «Отказ CLI мимо ACL контроллера».
- «Текущий шаг в панели статуса»: «Инструмент выполняется долго», «Ожидание модели», «Гейт контроллера».
- «Активные субагенты в панели статуса»: «Вложенный субагент», «CLI упал без ответа».
- «Отказы ACL в панели статуса»: «Отказ во время работы».

Capability `role-sessions`:

- «Сторож простоя сессии»: «Сессия молчит», «Сторож выключен», «Порог меньше таймаута запроса».
- «Прерывание сессии по решению о вмешательстве»: «Повтор после простоя», «Остановка после простоя».
- «Объяснение отказа ACL роли»: «Shell-команда вместо гейта».
- «Категория и подсказка отказа ACL»: «Запись вне разрешённых glob», «Операция гейта не разрешена»,
  «Шаг только на чтение».
- «Серия отказов ACL»: «Роль пробует обойти запрет», «Разрешённый вызов сбрасывает серию», «Промпт повтора».

Capability `human-decisions`:

- «Диалог вмешательства в работающую сессию»: «Простой implementer», «Ждать дальше».
- «Рекомендация при вмешательстве»: «Автопилот и вечный простой», «Не хватает разрешения».
- «Сессия ожила во время диалога»: «Модель ответила», «Отказы во время диалога серии ACL».

## Environment

- Kit с зависимостями (`npm install`), Node ≥ 22.13.
- **Офлайн-модули.** Тесты `e2e/stall-diagnostics.test.js` (node:test) импортируют модули контроллера
  через tsx (`node --import tsx --test e2e/stall-diagnostics.test.js`):
  - `tools/agentflow/roles.ts` — решение ACL (`decideAcl`) с категорией, подсказкой и
    разрешённым для модели;
  - `tools/agentflow/session-tracker.ts` — отслеживание сессии с подставленными часами;
    на вход подаются сообщения потока SDK в форме из `@qwen-code/sdk` (`assistant` с `tool_use`,
    `user` с `tool_result`, `parent_tool_use_id`) и `permission_denials` из `result`;
  - `tools/agentflow/status-panel.ts` — `renderPanel(state, width, now)`, сравнение по `stripAnsi`,
    уровень подсветки — по ANSI-цвету длительности (33 — жёлтый, 31 — красный);
  - Policy — `loadPolicy` kit, ключи `limits.*` и `roles.*` подменяются в тесте.
- **Mock-прогоны.** Копия kit с `git init` и начальным коммитом (mock создаёт ветку и worktree).
  Команда: `node tools/agentflow/bin/agentflow.mjs run tasks/01-slugify.md --mock --auto-approve --inject <точки>`,
  stdout в файл, stdin из `/dev/null`. Журнал — `.agentflow-runs/<run>/events.jsonl`, run id из вывода.
  Под `--mock` порог простоя 2 с.
- **Интерактивные сценарии** (меню, панель, ожившая сессия) проверяются в псевдотерминале:
  `e2e/helpers/pty-run.py` запускает команду через `pty.fork` с размером 30×120, пишет сырой
  вывод в файл и по таймеру вводит клавиши. Запуск — `python3 -I`. Если хелпера нет, его создаёт acceptance-tester.
  Панель — текст после позиционирования в три нижние строки (`ESC[28;1H`, `ESC[29;1H`, `ESC[30;1H`).

## Scenarios

| Requirement | Scenario | Steps (inputs) | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| Видимость работы субагентов | Список субагентов | Mock-прогон `--inject all`, затем `agentflow agents <run-id>` | Строка на каждую сессию: роль, id, запрошенная модель, модель init и из ответов | `e2e/evidence/stall-mock-all.log` |
| Видимость работы субагентов | Время событий роли | Тот же mock-прогон | Каждая строка вида `<роль> │ …` содержит `\d\d:\d\d:\d\d` сразу после `│ `; строка `▶ субагент <роль>` содержит время | `e2e/evidence/stall-mock-all.log` |
| Видимость работы субагентов | Сводка отказов в итоге роли | Tracker implementer: ACL-отказы `run_shell_command npm test` ×2 и `write_file openspec/specs/x/spec.md` ×1, затем `summary(permission_denials)` с тремя соответствующими элементами | Две группы: `2×` shell с причиной и подсказкой, `1×` запись с причиной и подсказкой; итог 3 | `e2e/evidence/stall-diagnostics.log` |
| Видимость работы субагентов | Отказ CLI мимо ACL контроллера | Tracker без ACL-отказов, `permission_denials` = `[run_shell_command {command: "git status"}]` | Одна группа с пометкой «отклонено CLI», текст упоминает `denyAll` и настройки CLI | `e2e/evidence/stall-diagnostics.log` |
| Видимость работы субагентов | (негатив) Отказов нет | `summary([])` без ACL-отказов | Групп нет, итог 0 | `e2e/evidence/stall-diagnostics.log` |
| Текущий шаг в панели статуса | Инструмент выполняется долго | `renderPanel`: агент implementer, шаг `run_shell_command agentflow-gate unit` с `since` = 14:02:31, `now` = since + 9 мин, `stallMs` = 15 мин | Строка шага содержит `agentflow-gate unit`, `с 14:02:31`, `09:00`, длительность жёлтая | `e2e/evidence/stall-diagnostics.log` |
| Текущий шаг в панели статуса | (негатив) Простой | То же, `now` = since + 16 мин | Длительность красная | `e2e/evidence/stall-diagnostics.log` |
| Текущий шаг в панели статуса | Ожидание модели | Tracker: `tool_use` id 1 → `tool_result` id 1 в момент T; `step()` | Шаг — ожидание ответа модели, `since` = T | `e2e/evidence/stall-diagnostics.log` |
| Текущий шаг в панели статуса | Гейт контроллера | `renderPanel` без агента, `activity` = гейт `unit` выполняется, `activitySince` задан. В pty: mock-прогон, кадры панели после строки `● гейт` предыдущей роли | Строка шага содержит `гейт unit` и `с HH:MM:SS`. В pty: перед строкой `● гейт unit` в панели был кадр с `гейт unit` | `e2e/evidence/stall-diagnostics.log`, `e2e/evidence/stall-pty-panel.raw` |
| Активные субагенты в панели статуса | Вложенный субагент | Tracker: `tool_use` `task` id 7, затем сообщение с `parent_tool_use_id: 7`; `renderPanel` со счётчиками tracker | `nested` = 1; первая строка содержит `активных 1 (+1 вложенный)`; после `tool_result` id 7 — `nested` = 0 | `e2e/evidence/stall-diagnostics.log` |
| Активные субагенты в панели статуса | CLI упал без ответа | `runRole` с `pathToQwenExecutable`, указывающим на скрипт `exit 1` (`AGENTFLOW_QWEN_CLI`), панель на фейковом потоке (`panel.start(..., out)`) | После возврата `runRole` кадр панели содержит `активных 0` | `e2e/evidence/stall-diagnostics.log` |
| Отказы ACL в панели статуса | Отказ во время работы | Tracker implementer + ACL-отказ `run_shell_command npm test`; `renderPanel` | Строка шага содержит `ACL 1` и причину отказа | `e2e/evidence/stall-diagnostics.log` |
| Сторож простоя сессии | Сессия молчит | Mock-прогон `--inject stall:implementer` | Диалог вмешательства (`☺ ты: … молчит`), первая строка контекста — диагноз простоя implementer с шагом и `с HH:MM:SS`; в `events.jsonl` событие `stall` с ролью и шагом | `e2e/evidence/stall-mock-stall.log` |
| Сторож простоя сессии | Сторож выключен | Tracker с `stallMs` = 0, часы сдвинуты на 1 час | `stalled()` = false | `e2e/evidence/stall-diagnostics.log` |
| Сторож простоя сессии | Порог меньше таймаута запроса | Копия kit, в policy `limits.stallMinutes: 5`, `qwen.apiTimeoutSeconds: 600`; mock-прогон | В начале вывода предупреждение о том, что порог простоя не больше таймаута запроса; run продолжается | `e2e/evidence/stall-mock-threshold.log` |
| Сторож простоя сессии | (негатив) Активность сбрасывает отсчёт | Tracker: часы +14 мин, `event(...)`, часы +14 мин, порог 15 | `stalled()` = false | `e2e/evidence/stall-diagnostics.log` |
| Прерывание сессии по решению о вмешательстве | Повтор после простоя | Mock-прогон `--inject stall:implementer` | После `→ Прервать сессию и повторить шаг` — `ошибка шага (… простой …) — попытка 1/3`, затем новая сессия implementer (новый `▶ субагент implementer` с другим id) и `■ implementer завершил`; run принят | `e2e/evidence/stall-mock-stall.log` |
| Прерывание сессии по решению о вмешательстве | Остановка после простоя | Mock-прогон `--inject stall:implementer` в pty без `--auto-approve`, на меню вмешательства выбрать «Остановить» (стрелки + Enter); затем `agentflow status <run>` и `agentflow resume <run> --auto-approve` | Run в BLOCKED, причина упоминает простой implementer; `resume` продолжает этап apply и доходит до приёмки, принятые артефакты не переделываются | `e2e/evidence/stall-pty-stop.raw`, `e2e/evidence/stall-resume.log` |
| Объяснение отказа ACL роли | Shell-команда вместо гейта | `decideAcl` implementer (`shell: [lint, unit]`), `run_shell_command` `npm test` | `ok: false`; разрешённое для модели содержит `agentflow-gate lint` и `agentflow-gate unit`; сообщение модели (через `aclFor` или функцию сообщения) содержит их и просьбу не повторять | `e2e/evidence/stall-diagnostics.log` |
| Категория и подсказка отказа ACL | Запись вне разрешённых glob | `decideAcl` spec-author, `write_file` `docs/notes.md` | `category` = permission; `hint` содержит `roles.spec-author.write` и `docs/notes.md` | `e2e/evidence/stall-diagnostics.log` |
| Категория и подсказка отказа ACL | Операция гейта не разрешена | `decideAcl` implementer, `agentflow-gate e2e` (`e2e` есть в `gates.ops`) | `category` = permission; `hint` содержит `roles.implementer.shell` и `e2e` | `e2e/evidence/stall-diagnostics.log` |
| Категория и подсказка отказа ACL | Шаг только на чтение | `decideAcl` spec-author, `readOnly: true`, `write_file` `openspec/changes/x/proposal.md` | `category` = expected; `hint` говорит, что действий не требуется | `e2e/evidence/stall-diagnostics.log` |
| Категория и подсказка отказа ACL | (негатив) Разрешённый вызов | `decideAcl` implementer, `agentflow-gate lint` | `ok: true`, категории отказа нет | `e2e/evidence/stall-diagnostics.log` |
| Категория и подсказка отказа ACL | (негатив) Защищённый путь | `decideAcl` implementer, `write_file` `openspec/specs/x/spec.md` | `ok: false`, `category` = expected, `hint` упоминает `denyWrite` | `e2e/evidence/stall-diagnostics.log` |
| Серия отказов ACL | Роль пробует обойти запрет | Tracker с `denialStreak` = 5, пять ACL-отказов подряд | `streakHit()` = true после пятого, false после четвёртого | `e2e/evidence/stall-diagnostics.log` |
| Серия отказов ACL | Разрешённый вызов сбрасывает серию | Четыре отказа, ACL-разрешение `agentflow-gate lint`, ещё один отказ | `streakHit()` = false, серия = 1 | `e2e/evidence/stall-diagnostics.log` |
| Серия отказов ACL | (негатив) Успешный результат инструмента без ACL сбрасывает серию | Четыре отказа, `tool_result` без `is_error` (read_file), один отказ | Серия = 1 | `e2e/evidence/stall-diagnostics.log` |
| Серия отказов ACL | Промпт повтора | Не проверяется снаружи на mock: mock-роли не получают отказов. Проверка — функция дополнения промпта, если она экспортирована (вход: список отказов и policy роли) | Текст содержит каждый отклонённый вызов и разрешённые операции роли | `e2e/evidence/stall-diagnostics.log` |
| Диалог вмешательства в работающую сессию | Простой implementer | pty, mock-прогон `--inject stall:implementer` без `--auto-approve`, Enter не нажимать 3 с после появления меню | Меню содержит роль, последнее действие с временем и три варианта; между началом меню и выбором в сыром выводе нет строк `implementer │` | `e2e/evidence/stall-pty-menu.raw` |
| Диалог вмешательства в работающую сессию | Ждать дальше | Там же, выбрать первый вариант (Enter, рекомендован «Ждать дальше») | Панель снова в нижних строках, через 2 с открывается второй диалог (простой №2) | `e2e/evidence/stall-pty-menu.raw` |
| Рекомендация при вмешательстве | Автопилот и вечный простой | Mock-прогон `--inject stall:implementer` с `--auto-approve` | Последовательно `(--auto-approve) → Ждать дальше`, затем `→ Прервать сессию и повторить шаг`; run не висит дольше 60 с. Цепочка до остановки (простой №3 → «Остановить») проверяется функцией рекомендации: номер 3 → stop | `e2e/evidence/stall-mock-stall.log`, `e2e/evidence/stall-diagnostics.log` |
| Рекомендация при вмешательстве | Не хватает разрешения | Функция рекомендации: серия ACL с одним отказом категории permission (`roles.implementer.write`) | Рекомендация stop, обоснование содержит `roles.implementer.write`; при всех expected — retry | `e2e/evidence/stall-diagnostics.log` |
| Сессия ожила во время диалога | Отказы во время диалога серии ACL | Не воспроизводится mock-ролью (mock не получает отказов). Проверка — сторож с заглушкой `intervene`, которая ждёт 1,5 с, на сессии, где серия отказов уже набрана и приходят новые сообщения | `signal` заглушки не прерван, решение исполнено | `e2e/evidence/stall-diagnostics.log` |
| Сессия ожила во время диалога | Модель ответила | Не воспроизводится mock-ролью снаружи: `silent`-сессия mock не оживает сама. Проверка — `Human.select` с `signal`, прерванным через 200 мс, в pty | `select` возвращает «отменено» без выбора, меню убрано | `e2e/evidence/stall-pty-woke.raw` |

## Evidence

- `e2e/evidence/stall-diagnostics.log` — вывод `node --import tsx --test e2e/stall-diagnostics.test.js`.
- `e2e/evidence/stall-mock-all.log` — вывод mock-прогона `--inject all` и `agentflow agents`.
- `e2e/evidence/stall-mock-stall.log` — вывод mock-прогона `--inject stall:implementer --auto-approve`
  и выдержка событий `stall`/`intervention` из `events.jsonl`.
- `e2e/evidence/stall-mock-threshold.log` — прогон с порогом меньше таймаута запроса.
- `e2e/evidence/stall-pty-*.raw`, `e2e/evidence/stall-resume.log` — сырой вывод псевдотерминала и resume.

## Manual check

1. На gigacode запустить run с `limits.stallMinutes: 1` в policy целевого репозитория и
   effort `max` у implementer. Панель показывает строку шага с временем начала, через минуту
   без событий открывается диалог вмешательства с понятным диагнозом.
2. Попросить implementer в intent «запусти npm test». В логе строки `✗ ACL … — ожидаемо`
   и `что делать: …`. Итог роли перечисляет отказы группами. Если модель упорствует, после
   пяти отказов подряд открывается диалог серии ACL.
3. В TTY нажать Ctrl+C во время диалога вмешательства: терминал восстановлен, run можно
   продолжить `agentflow resume`.
4. Mock-прогон в TTY: панель в три строки, `активных 1` во время роли и `активных 0` между ролями.
