# Cockpit

A macOS terminal with Claude Code built in. Each tab is a real zsh running in a pty; type `claude` to turn the tab into a Claude Code chat for that folder.

Tauri 2 + Rust on the backend, Vue 3 + Tailwind on the front.

## Run

```sh
bun install
bun tauri dev
```

## Test

```sh
bun run test        # frontend (vitest)
bun run test:rust   # backend (cargo test, includes a live zsh pty test)
bun run test:all
```

## Layout

- `src-tauri/src/lib.rs` — pty shells, Claude Code process control, session files, logs on disk
- `src/store/` — app state: `state.ts` (tabs, repos, chats, logs), `terminal.ts` (shell blocks, completion), `claude.ts` (chat, permissions, slash commands)
- `src/components/` — `Terminal` + `CommandBlock` (shell mode), `Transcript` + `LogItem` (chat mode), `Composer` (input), `AltScreen` (full-screen apps)
- `src/lib/` — Claude stream parser, pty client, markdown/ansi renderers, syntax highlighter

Chat history is stored in `~/Library/Application Support/com.peter.cockpit/logs/`.
