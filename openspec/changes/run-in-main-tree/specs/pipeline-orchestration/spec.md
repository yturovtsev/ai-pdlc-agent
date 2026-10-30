# Spec Delta

## MODIFIED Requirements

### Requirement: Порядок этапов
Контроллер SHALL выполнять этапы clarify → spec → approval → freeze → apply → acceptance → final → report → human-acceptance → archive, пропуская завершённые, в отдельной ветке `agentflow/<change>`: по умолчанию — в основном дереве репозитория, с `--worktree` или пунктом меню «Отдельный worktree» — в git worktree каталога run.

#### Scenario: Новый run
- **WHEN** выполняется `agentflow run <intent>` в репозитории на ветке `main`
- **THEN** создаётся каталог `.agentflow-runs/<run-id>/`, основное дерево переключается на новую ветку `agentflow/<change>` от HEAD, этапы идут по порядку, коммиты контроллера — в этой ветке

#### Scenario: Run в worktree
- **WHEN** выполняется `agentflow run <intent> --worktree`
- **THEN** ветка основного дерева не меняется, код и спека меняются в `.agentflow-runs/<run-id>/worktree` на ветке `agentflow/<change>`

## ADDED Requirements

### Requirement: Run в основном дереве
В основном дереве SHALL идти не больше одного run: второй run SHALL NOT стартовать, пока жив процесс первого, а lock упавшего процесса SHALL сниматься. Незакоммиченные правки вне `openspec/changes/<change>/` SHALL NOT останавливать старт, лог SHALL их перечислять с предупреждением, что они попадут в первый коммит контроллера. `.agentflow-runs/` SHALL быть игнорируемым git: если `.gitignore` его не покрывает, контроллер SHALL дописать его в `.git/info/exclude`. `resume` такого run SHALL идти только на его ветке. Отчёт и итог run SHALL называть ветку, с которой run начался, и шаги merge.

#### Scenario: Второй run в том же дереве
- **WHEN** run A ещё идёт в основном дереве и выполняется `agentflow run` другого change без `--worktree`
- **THEN** второй run не стартует и ветку не создаёт, сообщение называет run A и предлагает `--worktree`

#### Scenario: Чужие правки при старте
- **WHEN** в основном дереве изменён `README.md` и выполняется `agentflow run tasks/01-slugify.md --mock --auto-approve`
- **THEN** лог предупреждает о `README.md`, run доходит до архива, `README.md` — в коммите freeze ветки run

#### Scenario: Resume на чужой ветке
- **WHEN** run основного дерева остановлен на ветке `agentflow/add-slugify`, человек переключился на `main` и выполняет `agentflow resume <run-id>`
- **THEN** resume не продолжает run и называет команду `git switch agentflow/add-slugify`

#### Scenario: Итог run
- **WHEN** run основного дерева, начатый с `main`, принят и заархивирован
- **THEN** итог в логе и `ACCEPTANCE.md` содержат `git switch main` и `git merge agentflow/<change>` и не содержат `git worktree remove`
