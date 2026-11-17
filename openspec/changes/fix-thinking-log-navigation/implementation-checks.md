# Проверки реализации

Выполнено 16.11.2026. Это автоматические проверки реализации; отдельная acceptance-роль и ручная приёмка iTerm2 по `test-plan.md` здесь не выполнялись.

## Обязательные проверки

- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npm run test:agentflow` — 136/136 PASS.
- `openspec validate fix-thinking-log-navigation --strict` — PASS.
- `openspec validate --specs` — 7/7 PASS; информационные сообщения о длине существующих требований не являются ошибками.
- `git diff --check` — PASS.

Тесты проверяют страницы журнала и старый state.json, вытеснение кэша, физическую доставку событий в эмуляторе, медленное и быстрое колесо, границы, якорь и followTail, раскрытие всех 80 строк, повторное сворачивание, preview 0, размеры 30×120/10×40/8×30, диалоги, ошибки журнала, последовательные и одновременные процессы записи файлов, ссылки с пробелами и `#`. Дочерние процессы с fake TTY проверяют успех, BLOCKED, исключение, SIGINT/SIGTERM и однократный transcript.

## Mock и PTY

Прогоны выполнялись в новых копиях kit с отдельным `git init -b main` и начальным коммитом. Рабочий kit остался на `master`.

Каталог локальных результатов: `/private/tmp/agentflow-navigation-check-6xu_5tkr/`.

- `mock-all`: `node tools/agentflow/bin/agentflow.mjs run tasks/01-slugify.md --mock --auto-approve --inject all` — код 0, run `20261116-144555-add-slugify` принят, change архивирован в копии. Сводка содержит REVISE артефакта, сквозного ревью, батча и финала, красный гейт и обсуждения.
- `pty2`: `run tasks/01-slugify.md --mock --auto-approve --inject think-long:spec-author --thinking-chars 200`, затем байт Ctrl+C — код 130. `resume 20261116-145105-add-slugify --auto-approve` — код 0, статус accepted.
- `pty2-no-panel`: такой же прогон и resume с `--no-panel` — коды 130/0, run `20261116-145116-add-slugify`, статус accepted.
- В каждом PTY-run после resume два разных файла `display/*.jsonl`; SHA-256 трёх прежних файлов размышлений не изменился. Результаты — `pty-results.json`.
- После каждого PTY-процесса проверены ECHO/ISIG/ICANON до закрытия управляющей сессии. В каждом выводе ровно один вход и выход 1049, нет DECSTBM. Логи — `pty2-ctrl-c.log`, `pty2-resume.log`, `pty2-no-panel-ctrl-c.log`, `pty2-no-panel-resume.log`.
- Потоковые smoke со `--skip-roles implementer`: TTY с `--no-mouse`, TTY с `AGENTFLOW_NO_MOUSE=1`, stdout в pipe — коды 0. В TTY нет окна и перехвата мыши, OSC 8 присутствуют; в pipe нет ESC-последовательностей. Логи — `stream-flag.log`, `stream-env.log`, `stream-pipe.log`.

PTY подтверждает запуск CLI, сигналы, режимы и сохранность файлов; движение видимого окна проверено unit-эмулятором. Ни один из этих результатов не выдаётся за ручную проверку реального iTerm2.

## Замер модели

На локальной машине, без отрисовки реального терминала: 10 000 записей — 96 мс на добавление; 100 кадров с прокруткой — 16 мс; переукладка с ширины 120 на 40 — 70 мс. Это наблюдение, а не гарантия времени отклика.

## Перед архивированием

Нужны отдельная acceptance-роль и ручные шаги iTerm2 из `test-plan.md` с фиксацией версии, настроек и результата. Активный `expand-thinking` нельзя архивировать поверх нового контракта без повторного согласования его дельты.
