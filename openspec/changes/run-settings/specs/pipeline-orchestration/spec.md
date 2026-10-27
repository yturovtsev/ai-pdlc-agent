# Spec Delta

## ADDED Requirements

### Requirement: Диалог настроек run
При `agentflow run` в интерактивном терминале без `--auto-approve`, `--auto-until-review` и `--skip-roles` контроллер SHALL до создания ветки показать меню с галочками: пять ролей, «Уточнение intent», «Автопилот», «Автопилот до приёмки», «Панель статуса» и «Мышь». spec-author SHALL быть отмечен и недоступен для снятия. Начальное состояние «Уточнения intent», «Автопилота», «Панели статуса» и «Мыши» SHALL задаваться флагами `--no-clarify`, `--auto-approve`, `--no-panel` и `--no-mouse`; при `AGENTFLOW_NO_PANEL=1` или `AGENTFLOW_NO_MOUSE=1` пункт SHALL быть снят и недоступен. Остальные роли SHALL быть отмечены, «Автопилот до приёмки» — снят. Меню SHALL NOT подтверждаться, пока отмечены оба автопилота.

#### Scenario: Выключить code-reviewer
- **WHEN** человек снимает галочку code-reviewer и подтверждает меню
- **THEN** run стартует, в логе строка о выключенной роли code-reviewer, батчи принимаются без ревью кода

#### Scenario: Подтвердить без изменений
- **WHEN** человек нажимает Enter, ничего не меняя
- **THEN** run идёт со всеми пятью ролями, уточнением intent, панелью и мышью и без автопилота, как без диалога

#### Scenario: Обязательная роль
- **WHEN** человек пытается снять галочку spec-author
- **THEN** галочка не снимается, рядом показана причина «обязательная роль»

#### Scenario: Автопилот в настройках
- **WHEN** человек отметил «Автопилот» и подтвердил меню
- **THEN** решения человека в этом run выбираются как с `--auto-approve`

#### Scenario: Два автопилота
- **WHEN** человек отметил «Автопилот» и «Автопилот до приёмки» и нажал Enter
- **THEN** меню не закрывается, под ним сообщение о несовместимости; после снятия одной галочки run стартует с оставшимся режимом

#### Scenario: Без панели из меню
- **WHEN** человек снял «Панель статуса» и подтвердил меню
- **THEN** run идёт без панели внизу терминала, как с `--no-panel`

### Requirement: Выключение ролей без диалога
Флаг `--skip-roles <роль,роль>` SHALL выключать перечисленные роли без диалога настроек. Без TTY, с `--auto-approve` или с `--auto-until-review` диалог SHALL NOT показываться, а настройки SHALL браться из флагов. spec-author или неизвестная роль в `--skip-roles` SHALL останавливать запуск до создания ветки с сообщением, какие роли можно выключить.

#### Scenario: Запуск из скрипта
- **WHEN** выполняется `agentflow run tasks/01-slugify.md --mock --auto-approve --skip-roles code-reviewer,acceptance-tester`
- **THEN** диалога нет, ревью кода и этапа acceptance нет, change архивируется

#### Scenario: Обязательная роль во флаге
- **WHEN** выполняется `agentflow run tasks/01-slugify.md --skip-roles spec-author`
- **THEN** run не создаётся, ветки и worktree нет, сообщение: выключить можно spec-reviewer, implementer, code-reviewer, acceptance-tester

### Requirement: Настройки прогона в состоянии и отчёте
Выключенные роли, уточнение intent и автопилот SHALL записываться в `state.json` при старте run, а `agentflow resume` SHALL продолжать с ними. Лог в начале run и `ACCEPTANCE.md` SHALL называть выключенные роли и пропущенные из-за них шаги, сводка петель — показывать пропущенные петли как SKIPPED. Панель статуса SHALL считать только включённые роли.

#### Scenario: Resume с выключенной ролью
- **WHEN** run с выключенным code-reviewer остановлен после первого батча, затем выполняется `agentflow resume <run-id>`
- **THEN** второй батч тоже принимается без ревью кода

#### Scenario: Отчёт
- **WHEN** run прошёл с выключенными spec-reviewer и acceptance-tester
- **THEN** в `ACCEPTANCE.md` раздел «Настройки прогона» называет обе роли и пропущенные шаги: ревью артефактов, сквозное ревью, acceptance

### Requirement: Run только со спекой
Выключенный implementer SHALL выключать вместе с собой code-reviewer и acceptance-tester. Такой run SHALL завершаться на freeze спеки: этапы apply, acceptance и финала SHALL пропускаться, `openspec archive` SHALL NOT выполняться, change SHALL оставаться активным в ветке run, статус run — `accepted`. Диалог freeze SHALL предлагать «Заморозить и завершить run». В режиме `--auto-until-review` run SHALL парковаться на «Принять спеку?»; без режима отдельной приёмки нет — спеку человек принял на freeze. `ACCEPTANCE.md` SHALL называть пропущенные шаги и не содержать трассировки кода.

#### Scenario: Только спека
- **WHEN** выполняется `agentflow run tasks/01-slugify.md --mock --auto-approve --skip-roles implementer`
- **THEN** код 0, нет сессий implementer, code-reviewer и acceptance-tester, в ветке run есть коммит freeze, `openspec/changes/add-slugify` не перенесён в архив

#### Scenario: Код по готовой спеке
- **WHEN** ветка run только со спекой слита, затем выполняется `agentflow run --change add-slugify --mock --auto-approve`
- **THEN** артефакты проходят ревью, run доходит до apply и archive, код 0

#### Scenario: Парковка спеки
- **WHEN** выполняется `agentflow run tasks/01-slugify.md --mock --auto-until-review --skip-roles implementer`
- **THEN** код 0, статус `awaiting-review`, в выводе «спека add-slugify ждёт твоего ревью»; `resume` в терминале открывает «Принять спеку?»
