# Spec Delta

## ADDED Requirements

### Requirement: Диалог настроек run
При `agentflow run` в интерактивном терминале без `--auto-approve` и без `--skip-roles` контроллер SHALL до создания ветки показать меню с галочками: пять ролей, «Уточнение intent» и «Автопилот». spec-author и implementer SHALL быть отмечены и недоступны для снятия. Начальное состояние «Уточнения intent» и «Автопилота» SHALL задаваться флагами `--no-clarify` и `--auto-approve`, остальные галочки SHALL быть отмечены.

#### Scenario: Выключить code-reviewer
- **WHEN** человек снимает галочку code-reviewer и подтверждает меню
- **THEN** run стартует, в логе строка о выключенной роли code-reviewer, батчи принимаются без ревью кода

#### Scenario: Подтвердить без изменений
- **WHEN** человек нажимает Enter, ничего не меняя
- **THEN** run идёт со всеми пятью ролями, уточнением intent и без автопилота, как без диалога

#### Scenario: Обязательная роль
- **WHEN** человек пытается снять галочку implementer
- **THEN** галочка не снимается, рядом показана причина «обязательная роль»

#### Scenario: Автопилот в настройках
- **WHEN** человек отметил «Автопилот» и подтвердил меню
- **THEN** решения человека в этом run выбираются как с `--auto-approve`

### Requirement: Выключение ролей без диалога
Флаг `--skip-roles <роль,роль>` SHALL выключать перечисленные роли без диалога настроек. Без TTY или с `--auto-approve` диалог SHALL NOT показываться, а настройки SHALL браться из флагов. Обязательная или неизвестная роль в `--skip-roles` SHALL останавливать запуск до создания ветки с сообщением, какие роли можно выключить.

#### Scenario: Запуск из скрипта
- **WHEN** выполняется `agentflow run tasks/01-slugify.md --mock --auto-approve --skip-roles code-reviewer,acceptance-tester`
- **THEN** диалога нет, ревью кода и этапа acceptance нет, change архивируется

#### Scenario: Обязательная роль во флаге
- **WHEN** выполняется `agentflow run tasks/01-slugify.md --skip-roles implementer`
- **THEN** run не создаётся, ветки и worktree нет, сообщение: выключить можно spec-reviewer, code-reviewer, acceptance-tester

### Requirement: Настройки прогона в состоянии и отчёте
Выключенные роли, уточнение intent и автопилот SHALL записываться в `state.json` при старте run, а `agentflow resume` SHALL продолжать с ними. Лог в начале run и `ACCEPTANCE.md` SHALL называть выключенные роли и пропущенные из-за них шаги, сводка петель — показывать пропущенные петли как SKIPPED. Панель статуса SHALL считать только включённые роли.

#### Scenario: Resume с выключенной ролью
- **WHEN** run с выключенным code-reviewer остановлен после первого батча, затем выполняется `agentflow resume <run-id>`
- **THEN** второй батч тоже принимается без ревью кода

#### Scenario: Отчёт
- **WHEN** run прошёл с выключенными spec-reviewer и acceptance-tester
- **THEN** в `ACCEPTANCE.md` раздел «Настройки прогона» называет обе роли и пропущенные шаги: ревью артефактов, сквозное ревью, acceptance
