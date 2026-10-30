# Design

## Context

- `startRun` создаёт каталог run, затем `git worktree add -b agentflow/<change>` в
  `.agentflow-runs/<run>/worktree`. Незакоммиченное из `openspec/` и игнорируемые схемы с config он
  копирует в worktree. Путь пишется в `state.worktree`.
- Почти весь контроллер работает через `ctx.wt` (`state.worktree`): роли, гейты, OpenSpec, коммиты,
  diff и проверка границ. ACL ролей (`decideAcl`) считает пути относительно `rt.worktree`.
- `.agentflow-runs/*/*` в `.gitignore`, кроме `ACCEPTANCE.md`. Каталог run лежит вне worktree, поэтому
  роли туда не пишут, а git его не видит.
- Ролям на чтение открыт только `contexts/` run (`includeDirectories`).

## Goals / Non-Goals

**Goals:**
- Режим дерева — одно поле `state.worktree`. Основное дерево — когда оно равно `repoRoot`, остальной
  контроллер не ветвится.
- Старые run на worktree продолжают resume без миграции.

**Non-Goals:**
- Несколько run в одном основном дереве.

## Decisions

1. **Основное дерево по умолчанию, worktree флагом.** Для run основного дерева `state.worktree =
   repoRoot`, ветка создаётся `git switch -c` от HEAD. Незакоммиченное переходит на ветку само, и
   копировать `openspec/` не нужно. Альтернатива — коммитить в текущую ветку. Отклонена: коммиты
   раундов («batch N раунд 2») засорили бы ветку человека.
2. **Lock в каталоге git.** `git rev-parse --git-path agentflow.lock` — вне дерева, поэтому lock не
   попадает в `git status` и коммиты. В `.agentflow-runs/.lock` его не покрыл бы шаблон
   `.agentflow-runs/*/*`. Lock держит `{runId, pid}`. Живой чужой pid — ошибка, мёртвый — lock
   перехватывается. Снимает lock только тот же run того же процесса, на `exit`.
3. **Каталог прогонов — только контроллеру.** В основном дереве каталог run лежит внутри дерева, а
   implementer пишет по `**`. Поэтому запрет зашит в `decideAcl`, а не в policy: списки policy
   репозитория заменяют списки kit, и запрет потерялся бы. `treeChanges` убирает `.agentflow-runs/` из
   проверки границ и проверки целостности: неигнорируемый `ACCEPTANCE.md` пишет контроллер.
4. **Игнор без правки `.gitignore`.** Если `git check-ignore` не видит `.agentflow-runs/<run>/state.json`
   игнорируемым, шаблон `/.agentflow-runs/` дописывается в `.git/info/exclude`. Это локально и не
   меняет файлы репозитория. `agentflow init` по-прежнему пишет строки в `.gitignore`.
5. **Чужие правки — предупреждение.** Решение человека: не останавливать run. Правки вне
   `openspec/changes/<change>/` перечисляются в логе. Они попадут в коммит freeze. Проверка границ
   после freeze их уже не видит: они закоммичены.
6. **Resume на своей ветке.** Ветка не та — ошибка с командой `git switch`. Автоматически не
   переключаем: в дереве могут быть правки человека.
7. **Копия схемы в contexts.** `makeCtx` копирует `review.schema.json` kit в `contexts/`, `BaseCtx`
   получает `schemaPath`, `contractExample` называет его в строке контракта. Берётся схема kit, а не
   репозитория: по ней проверяет `review-validator.ts`.

## Risks / Trade-offs

- Пока run идёт, дерево занято: правка человека вне change во время apply — нарушение границ ACL,
  run уходит в BLOCKED. → Для параллельной работы — `--worktree`.
- Роли могут читать `.agentflow-runs/` основного дерева, включая размышления других ролей. → Вне scope:
  запрет чтения отрезал бы и `contexts/` своего run.
