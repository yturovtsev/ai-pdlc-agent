# Test Plan

## Scope

Capability `human-decisions`:

- «Диалог при исчерпании лимита» (MODIFIED): «Артефакт не сходится» (регрессия), «Пункты диалога
  исчерпания батча».
- «Waiver» (MODIFIED): «Находки сняты» (регрессия), «Находки финала сняты переходом дальше».
- «Диалог вмешательства в работающую сессию» (MODIFIED): «Простой implementer», «Ждать дальше»
  (регрессия), «Перейти дальше из диалога простоя».
- «Всё равно перейти дальше»: «Принять без финального ревью», «Батч пройден решением человека»,
  «Артефакт принят как есть», «Уточнения intent пропущены», «Причина по умолчанию», «Автопилот не
  переходит дальше».
- «Переход дальше в отчёте приёмки»: «Отчёт после пропуска финала».
- «Переход дальше при ошибках валидации»: «Ошибка validate в specs».
- «Диалог блокера»: «BLOCKED в батче», «Контекст и повтор», «Автопилот на блокере», «Спор по
  безопасности».
- «Обсуждение решения с ролью»: «Обсуждение находок финала», «Роли петли», «Реплика только читает»,
  «Сбой реплики», «Пустая реплика».
- «Переписка обсуждения решения»: «Ещё раунд после обсуждения», «Лимит реплик».
- «Проверка диалогов без моделей»: «Пропуск финала на mock-ролях», «Блокер без перехода на
  mock-ролях», «Обсуждение решения на mock-ролях».

Capability `pipeline-orchestration`:

- «Остановка в BLOCKED» (MODIFIED): «Изменена замороженная спека» (регрессия), «Блокер роли».

Capability `review-contract`:

- «Решения, требующие человека» (MODIFIED): «Развилка в apply».

## Environment

- Kit с зависимостями (`npm install`), Node ≥ 22.13.
- **Mock-прогоны.** Копия kit с `git init` и начальным коммитом: mock создаёт ветку и worktree.
  Команда: `node tools/agentflow/bin/agentflow.mjs run tasks/01-slugify.md --mock --auto-approve --inject <точки>`,
  stdout в файл, stdin из `/dev/null`. Каждый прогон — в новой копии kit. Run id берётся из вывода.
  Журнал — `.agentflow-runs/<run>/events.jsonl`, состояние — `state.json`, отчёт — `ACCEPTANCE.md`,
  промпты ролей — `contexts/` каталога run. `resume` — `node tools/agentflow/bin/agentflow.mjs resume <run>`.
- **Интерактивные сценарии** — псевдотерминал `e2e/helpers/pty-run.py` (`pty.fork`, 30×120, запуск
  `python3 -I`, клавиши по таймеру: `↓` — `\x1b[B`, Enter — `\r`, текст — посимвольно). Прогон без
  `--auto-approve`, с точками inject, которые приводят к нужному диалогу. Пункты меню ищутся по
  тексту в выводе. Если хелпера нет, его создаёт acceptance-tester.
- **Офлайн-модули.** Где снаружи не воспроизвести (падение CLI на реплике, запись в сессии только на
  чтение, длинная переписка), тест `e2e/dialog-proceed.test.js` (node:test) импортирует модули через
  tsx (`node --import tsx --test e2e/dialog-proceed.test.js`):
  - `tools/agentflow/human.ts` — `new Human(false, io)`, где `io` — сценарий: `select` отдаёт
    заданные ключи по очереди и запоминает переданные варианты меню, включая `disabled`, `input`
    отдаёт заданные строки, `tty` → true. Обсуждение решения — заглушка ответа роли со сценарием
    (ответ или `{ error }`);
  - `tools/agentflow/roles.ts` — `decideAcl` с `readOnly: true`;
  - `tools/agentflow/report.ts` — `writeAcceptanceReport` на состоянии с записью о переходе дальше.
  Имена экспортов — по коду.

## Scenarios

| Requirement | Scenario | Steps (inputs) | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| Диалог при исчерпании лимита | Артефакт не сходится | Mock: `--inject artifact-stuck:specs` | В выводе диалог «Артефакт «specs»: 3 автоматических раунда без PASS» со списком находок `INJ-STUCK`. Автопилот выбрал «Ещё раунд…», прогон завершён | `e2e/evidence/dialog-mock-stuck.log` |
| Диалог при исчерпании лимита | Пункты диалога исчерпания батча | pty: `--inject batch-stuck:2` без `--auto-approve`, на остальных меню Enter. На диалоге исчерпания батча 2 снять экран | Пункты есть: «Обсудить с code-reviewer…», «Обсудить с implementer…». Предпоследний — «Остановить run…», последний — «Всё равно перейти дальше» с текстом «считать батч 2 выполненным → батч 3» | `e2e/evidence/dialog-pty-batch-menu.raw` |
| Waiver | Находки сняты | Mock: `--inject artifact-stuck:specs`. Модули: `Human` выбирает «waiver» с причиной | В `state.json` у находок specs `status: waived` с причиной. В `ACCEPTANCE.md` они в разделе снятых находок | `e2e/evidence/dialog-proceed.log` |
| Waiver | Находки финала сняты переходом дальше | Mock: `--inject final-revise,blocked:final,proceed:final` | Открытые находки финала в `state.json` — `waived`, причина «fault injection», snapshot финала. В `ACCEPTANCE.md` они в разделе снятых находок | `e2e/evidence/dialog-mock-final.log` |
| Диалог вмешательства в работающую сессию | Простой implementer | pty: `--inject stall:implementer` без `--auto-approve`. Снять экран диалога простоя | Меню из четырёх пунктов, последний — «Всё равно перейти дальше» | `e2e/evidence/dialog-pty-stall.raw` |
| Диалог вмешательства в работающую сессию | Ждать дальше | Mock: `--inject stall:implementer` | Первый простой — «Ждать дальше», затем повтор шага. Прогон завершён, как без изменения | `e2e/evidence/dialog-mock-stall.log` |
| Диалог вмешательства в работающую сессию | Перейти дальше из диалога простоя | Mock: `--inject stall:implementer,proceed:batch:1` | В `events.jsonl` сессия implementer батча 1 прервана. В `state.json` батч 1 `done` с отметкой о решении человека, задачи батча 1 в `tasks.md` не отмечены. Начинается батч 2. Его гейты в mock красные: код батча 1 не написан, и это ожидаемое следствие перехода | `e2e/evidence/dialog-mock-stall-proceed.log` |
| Всё равно перейти дальше | Принять без финального ревью | Mock: `--inject blocked:final,proceed:final` | Пункт в выводе — «Принять без финального ревью → отчёт приёмки». Затем этапы отчёта, «Принять change?» и archive, в логе git ветки коммит `archive`. Код выхода 0 | `e2e/evidence/dialog-mock-final.log` |
| Всё равно перейти дальше | Батч пройден решением человека | Mock: `--inject batch-stuck:2,proceed:batch:2` | Батч 2 `done` после диалога исчерпания. Чекбоксы его задач в `tasks.md` worktree пустые. Если батча 3 нет, следующий этап — acceptance | `e2e/evidence/dialog-mock-batch.log` |
| Всё равно перейти дальше | Артефакт принят как есть | Mock: `--inject artifact-stuck:specs,proceed:artifact:specs` | Сразу после диалога исчерпания specs нет диалога «Твоё ревью артефакта «specs»», следующая петля — «артефакт design». В `state.json` specs `accepted`. Отложенный вопрос автора по specs задаётся при согласовании спеки, как раньше | `e2e/evidence/dialog-mock-artifact.log` |
| Всё равно перейти дальше | Уточнения intent пропущены | Mock: `tasks/03-incomplete.md --inject stall:spec-author,proceed:clarify` | Шаг уточнений прерван, вопросов уточнения нет, дальше фаза спеки. В `state.json` решение `proceed` по уточнениям | `e2e/evidence/dialog-mock-clarify.log` |
| Всё равно перейти дальше | Причина по умолчанию | pty: `--inject blocked:final` без `--auto-approve`. В диалоге блокера финала выбрать последний пункт (`↓` до конца, Enter), на вопросе о причине — Enter | В `state.json` решение `proceed` с непустой причиной по умолчанию. Она же в `ACCEPTANCE.md` | `e2e/evidence/dialog-pty-reason.raw` |
| Всё равно перейти дальше | Автопилот не переходит дальше | Mock: `--inject batch-stuck:2` (без `proceed:`) | В выводе ни разу не выбран пункт «Всё равно перейти дальше». В `state.json` нет решений `proceed` | `e2e/evidence/dialog-mock-batch-noproceed.log` |
| Всё равно перейти дальше | (негатив) Пункт никогда не рекомендуется | Все mock-прогоны этого плана | Ни одна строка `★ рекомендуется:` в выводе не содержит «Всё равно перейти дальше» | все `dialog-mock-*.log` |
| Переход дальше в отчёте приёмки | Отчёт после пропуска финала | Тот же прогон, что «Принять без финального ревью» | В `ACCEPTANCE.md` раздел «Пройдено решением человека» с петлёй финального ревью, причиной и id снятых находок. В выводе диалога «Принять change?» нет «финальное ревью PASS», есть «пройдено решением человека» | `e2e/evidence/dialog-mock-final.log` |
| Переход дальше при ошибках валидации | Ошибка validate в specs | Модули: состояние с находкой валидатора у артефакта specs, `Human` со сценарием `io`. Меню исчерпания артефакта | Последний вариант меню — «Всё равно перейти дальше» с `disabled`: «без openspec validate --strict не пройдут freeze и archive». Сценарий не может его выбрать | `e2e/evidence/dialog-proceed.log` |
| Диалог блокера | BLOCKED в батче | pty: `--inject blocked:batch:1` без `--auto-approve`. Снять экран | Диалог с причиной вердикта, `★` у «Остановить run». В `state.json` в этот момент `status: running` | `e2e/evidence/dialog-pty-blocked.raw` |
| Диалог блокера | Контекст и повтор | pty: тот же прогон. Выбрать «Дать недостающий контекст…», ввести «используй ASCII» | В `state.json` в `intent.clarifications` есть этот текст. Промпт implementer следующего раунда батча 1 в `contexts/` содержит его как находку человека, затем гейты и ревью | `e2e/evidence/dialog-pty-blocked.raw` |
| Диалог блокера | Автопилот на блокере | Mock: `--inject blocked:acceptance` | Код выхода 2, `state.json` `status: blocked`, причина — вердикт acceptance-tester. Перед этим в выводе диалог блокера | `e2e/evidence/dialog-mock-blocked-acc.log` |
| Диалог блокера | Спор по безопасности | Модули: ревью батча с находкой security, ответ автора `disputed`, повтор находки ревьюером. Контроллер не импортируется (при импорте он запускает `main()`), поэтому — только mock-доступными средствами, если они есть. Иначе — ручная проверка | Диалог блокера с текстом находки и ответом автора. Если автоматизировать нельзя, так и записать в evidence | `e2e/evidence/dialog-proceed.log` |
| Диалог блокера | (негатив) Контроль целостности не открывает диалог | Mock: `--inject kill-after:freeze`. Изменить файл спеки в worktree, затем `resume` | Run сразу в BLOCKED с причиной «замороженная спека изменена», диалога блокера нет | `e2e/evidence/dialog-mock-freeze.log` |
| Обсуждение решения с ролью | Обсуждение находок финала | pty: `--inject final-revise,blocked:final` без `--auto-approve`. Выбрать «Обсудить с code-reviewer…», ввести реплику | Под меню ответ code-reviewer (mock) с текстом реплики, затем снова меню с теми же пунктами | `e2e/evidence/dialog-pty-discuss.raw` |
| Обсуждение решения с ролью | Роли петли | pty: `--inject artifact-stuck:specs` и отдельно `--inject blocked:acceptance`, без `--auto-approve` | В первом меню «Обсудить с spec-reviewer…» и «Обсудить с spec-author…». Во втором только «Обсудить с acceptance-tester…» | `e2e/evidence/dialog-pty-partners.raw` |
| Обсуждение решения с ролью | Реплика только читает | Модули: `decideAcl` с `readOnly: true` для `write_file` | Отказ с причиной «шаг только на чтение» | `e2e/evidence/dialog-proceed.log` |
| Обсуждение решения с ролью | Сбой реплики | Модули: заглушка ответа роли отдаёт `{ error: 'CLI exited with code 1' }` | Причина в логе, меню показано снова, переписка пустая | `e2e/evidence/dialog-proceed.log` |
| Обсуждение решения с ролью | Пустая реплика | Модули: выбрать обсуждение, `input` отдаёт пустую строку | Заглушка роли не вызвана, меню показано снова | `e2e/evidence/dialog-proceed.log` |
| Переписка обсуждения решения | Ещё раунд после обсуждения | pty: `--inject batch-stuck:2` без `--auto-approve`. Две реплики «Обсудить с implementer…», затем «Ещё раунд той же сессией implementer» | Промпт implementer следующего раунда в `contexts/` содержит обе реплики и ответы. В `state.json` переписка диалога. В `ACCEPTANCE.md` у решения «обсуждение: 2 реплики» | `e2e/evidence/dialog-pty-discuss-round.raw` |
| Переписка обсуждения решения | Лимит реплик | Модули: `limit: 5`, пять реплик, снова обсуждение | Диалог лимита, `★` у «Вернуться к выбору» | `e2e/evidence/dialog-proceed.log` |
| Проверка диалогов без моделей | Пропуск финала на mock-ролях | Mock: `--inject blocked:final,proceed:final` | Как в «Принять без финального ревью»: код 0, раздел «Пройдено решением человека» с петлёй финала | `e2e/evidence/dialog-mock-final.log` |
| Проверка диалогов без моделей | Блокер без перехода на mock-ролях | Mock: `--inject blocked:batch:1`, затем `resume <run>` | Первый прогон — код 2, `blocked`. `resume` — код 0, батч 1 прошёл ревью, change архивирован | `e2e/evidence/dialog-mock-blocked-resume.log` |
| Проверка диалогов без моделей | Обсуждение решения на mock-ролях | Mock: `--inject all` | В диалоге исчерпания specs строка реплики автопилота и ответ mock-роли, затем выбран рекомендуемый вариант. Сводка петель — как раньше, код 0 | `e2e/evidence/dialog-mock-all.log` |
| Остановка в BLOCKED | Изменена замороженная спека | См. негатив «Контроль целостности не открывает диалог» | Run в BLOCKED с причиной «замороженная спека изменена» | `e2e/evidence/dialog-mock-freeze.log` |
| Остановка в BLOCKED | Блокер роли | pty: `--inject blocked:final` без `--auto-approve`, снять экран до выбора | Диалог блокера финала открыт, `state.json` `status: running` | `e2e/evidence/dialog-pty-reason.raw` |
| Решения, требующие человека | Развилка в apply | Mock-роль не помечает `needsHuman`, точка `blocked:batch:1` даёт тот же путь вердикта BLOCKED. Проверяется прогоном «Автопилот на блокере» для батча: `--inject blocked:batch:1` | Диалог блокера батча, автопилот — «Остановить run», run `blocked` | `e2e/evidence/dialog-mock-blocked-resume.log` |

## Evidence

- `e2e/evidence/dialog-proceed.log` — вывод `node --import tsx --test e2e/dialog-proceed.test.js`.
- `e2e/evidence/dialog-mock-*.log` — вывод mock-прогонов, выдержки из `state.json`, `events.jsonl` и
  `ACCEPTANCE.md` по каждому сценарию.
- `e2e/evidence/dialog-pty-*.raw` — сырой вывод псевдотерминала и выдержки из `state.json`.

## Manual check

1. На gigacode довести батч до исчерпания (или сымитировать `--inject batch-stuck:1`). В диалоге
   выбрать «Обсудить с code-reviewer…» и спросить, какие находки критичны. Ответ роли по существу,
   меню вернулось.
2. Там же выбрать «Всё равно перейти дальше» и ввести причину. Батч закрыт, следующий батч начался,
   задачи батча в `tasks.md` не отмечены.
3. Запустить `--inject blocked:final` и выбрать «Принять без финального ревью». Открыть
   `ACCEPTANCE.md`: в разделе «Пройдено решением человека» финал и причина, в диалоге «Принять
   change?» нет утверждения о PASS финального ревью.
4. Проверить, что во всех открывшихся меню «★ рекомендуется» ни разу не стоит у «Всё равно перейти
   дальше».
