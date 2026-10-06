# Architecture

Nexus Code is a Windows desktop application that lets an external reasoning model
(`am/nemotron-3-ultra-550b-a55b`) operate on a real project through a controlled,
auditable execution layer.

## Two layers

| Layer | Responsibility |
|---|---|
| **AI reasoning layer** (external model) | Understanding requests, architecture decisions, planning, tool selection, interpreting results and errors, proposing fixes |
| **Application execution layer** (this app) | Filesystem, terminal, processes, Git, indexing, permissions, validation, context, persistence, verification, UI |

The model never touches the operating system. The only path is:

```
Nemotron → AgentController → ToolManager → PermissionManager → security validation → Windows tool → structured result → AgentController → Nemotron
```

## Technology choice

**Electron + React + TypeScript**, not Tauri.

| Criterion | Why Electron won |
|---|---|
| Process management | The agent must spawn, track and kill long-running dev servers and read their streaming output. Node's `child_process` in the main process does this directly; the Rust side of Tauri would need a bespoke supervisor. |
| Filesystem & Git integration | Node `fs`/`spawn` give atomic writes, mtime-based incremental indexing and direct `git` argv invocation with no extra IPC layer. |
| Security model | `contextIsolation` + no `nodeIntegration` + a single narrow preload bridge is sufficient; all privileged work already lives in the main process. |
| Maintainability | One language (TypeScript) across core, main process and UI — the agent core is therefore directly unit-testable with Vitest, which matters more than binary size for this product. |
| Credential storage | Electron `safeStorage` wraps Windows DPAPI without a native module. |

Cost: a larger installer. Accepted deliberately — reliability of the agent loop outranks binary size.

Persistence uses **SQLite** through Node's built-in `node:sqlite` (no native module to rebuild), with an
automatic JSON fallback so the app still starts if the module is unavailable.

## Module map

```
src/
├── core/                      pure TypeScript, no Electron imports → unit-testable
│   ├── agent/                 AgentController, state machine, task manager,
│   │                          requirement analyst, system prompts
│   ├── ai/                    AIProvider interface, OpenAI-compatible + Nemotron providers
│   ├── tools/                 tool definitions, JSON-schema validation, ToolManager pipeline
│   ├── permissions/           path guard, command risk classifier, PermissionManager
│   ├── indexer/               project indexer, technology detection, environment detection
│   ├── context/               context budgeting, relevance scoring, compression
│   ├── verification/          verification engine, framework detection, error classifier
│   ├── process/               shell runner, process manager, port detection
│   ├── git/                   GitManager (argv-based, never shell-interpolated)
│   ├── session/               SQLite/JSON store, SessionManager, CheckpointManager
│   └── shared/                types, IPC contract, logger, secret redaction
├── main/                      Electron main process: window, services wiring, IPC, settings
├── preload/                   the single contextBridge surface
└── renderer/                  React UI (no Node access at all)
```

`src/core` has no dependency on Electron, which is why the agent loop, tools, permissions and
verification engine are covered by real tests that run in plain Node.

## Data flow for one user request

1. `agent:send` IPC → `AgentController.run`
2. Project indexed (incremental on later turns) → project map, languages, frameworks, tests
3. Deterministic requirement pre-analysis → emitted to the UI and injected into the prompt
4. System prompt + project context + compressed history + tool schemas → provider (streaming)
5. Model returns text and/or tool calls
6. Each tool call: schema validation → path/command validation → permission check (possibly an
   approval card in the UI) → execution → structured result → appended to history as untrusted data
7. Meta tools drive the protocol: `record_requirements`, `ask_user`, `present_plan`, `update_task`,
   `verify_work`, `create_checkpoint`, `remember`, `finish`
8. Verification failures feed the repair loop until it succeeds or the repair limit is reached
9. `finish` produces the final report; unverified claims are annotated by the application itself

## Storage

```
%APPDATA%\NexusCode\
├── config\      settings.json + credentials.bin (DPAPI-encrypted API key)
├── database\    nexus.db (projects, sessions, messages, tasks, checkpoints, memory, agent_state…)
├── logs\        structured, secret-redacted daily logs
├── cache\  index\  sessions\
└── checkpoints\ file snapshots for restore points
```

The user's source code is never copied into application storage except inside explicit checkpoints —
the selected workspace remains the single source of truth.
