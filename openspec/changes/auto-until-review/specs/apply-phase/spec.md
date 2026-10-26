# Spec Delta

## MODIFIED Requirements

### Requirement: Приёмка и archive
Контроллер SHALL писать `ACCEPTANCE.md`, запрашивать решение человека и при принятии выполнять `openspec archive`; merge ветки — вне конвейера. В режиме `--auto-until-review` run SHALL вместо диалога парковаться: статус `awaiting-review`, код выхода 0, в логе путь к отчёту, worktree, ветка и команда resume. `agentflow resume` парковки SHALL сразу открывать «Принять change?»; без TTY run SHALL оставаться в `awaiting-review`.

#### Scenario: Change принят
- **WHEN** человек выбрал «Принять»
- **THEN** выполняется `openspec archive`, результат коммитится в ветку change, run получает статус accepted

#### Scenario: Парковка на приёмке
- **WHEN** run с `--auto-until-review` прошёл финальное ревью и написал отчёт
- **THEN** процесс завершается с кодом 0, `agentflow status` показывает `awaiting-review` на этапе human-acceptance, `openspec archive` не выполнялся, панели и режима мыши в терминале нет

#### Scenario: Приёмка после парковки
- **WHEN** для запаркованного run в TTY выполняется `agentflow resume <run-id>`
- **THEN** агенты не запускаются, сразу открывается «Принять change?», выбор «Принять» архивирует change и даёт статус accepted

#### Scenario: Resume парковки без TTY
- **WHEN** для запаркованного run выполняется `agentflow resume <run-id>` без TTY
- **THEN** статус остаётся `awaiting-review`, сообщение просит запустить resume в TTY, отчёт приёмки не меняется

## ADDED Requirements

### Requirement: Режим прогона в отчёте приёмки
Для run в режиме `--auto-until-review` `ACCEPTANCE.md` SHALL содержать раздел «Режим прогона»: режим, число решений автопилота, время и причина передачи решений человеку, число открытых находок critical и major, число waiver и переходов дальше. Шапка запаркованного отчёта SHALL показывать статус «ждёт ревью человека».

#### Scenario: Отчёт запаркованного run
- **WHEN** run с `--auto-until-review` запаркован на приёмке
- **THEN** в `ACCEPTANCE.md` статус «ждёт ревью человека», раздел «Режим прогона» с числом решений автопилота и причиной передачи «парковка на приёмке», открытых critical и major, waiver и переходов дальше — 0

#### Scenario: Run без режима
- **WHEN** run запущен без `--auto-until-review`
- **THEN** раздела «Режим прогона» в `ACCEPTANCE.md` нет
