# Development

## Requirements

Node.js ≥ 20.11 (22+ recommended so `node:sqlite` is available), npm, Git. Windows 10/11 x64 for the
packaged application; the core and the test-suite also run on Linux/macOS for development.

## Commands

```bash
npm install
npm run dev          # Electron app with hot reload
npm run preview:web  # renderer only, in a browser (no backend — clearly labelled preview mode)
npm run typecheck    # tsc for node-side and web-side projects
npm test             # full Vitest suite (unit, security, agent loop, acceptance scenarios)
npm run build        # typecheck + production bundles into out/
npm run build:win    # Windows NSIS installer → release/NexusCode-Setup-<version>.exe
```

## Layout rules

- `src/core` must never import Electron — that is what keeps it testable.
- Main-process code owns all privileged operations; the renderer only talks through `src/preload`.
- New IPC endpoints are declared in `src/core/shared/ipc.ts`, implemented in `src/main/ipc/handlers.ts`
  and exposed in `src/preload/index.ts`.

## Testing notes

The suite performs real work: it creates temporary workspaces, writes files, runs `npm test`,
`node`, `python3` and `git`, starts a real HTTP server and makes a real request to it. The model is
the only mocked component (`tests/helpers/mockProvider.ts`), because determinism there is what makes
the rest of the assertions meaningful.
