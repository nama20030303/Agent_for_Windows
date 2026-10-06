# Verification and self-repair

## Levels

| Level | How it is executed |
|---|---|
| 1 Syntax | `python -m compileall`, `tsc --noEmit`, compiler front-ends |
| 2 Static | project linter (`ruff`, `eslint`, `clippy`, `mypy`) when configured |
| 3 Build | `npm run build`, `dotnet build`, `cargo build`, `go build`, `mvn compile` |
| 4 Tests | `npm test`, `pytest`, `dotnet test`, `cargo test`, `go test` |
| 5 Runtime | `start_process` + `http_check` / process output inspection |
| 6 Functional | agent-driven workflow checks against the running app |

Commands are **detected, never invented**: `detectProjectCommands()` reads the real manifests
(`package.json` scripts, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.csproj`, …) and respects existing
virtual environments (`.venv`, `venv`). Nested `backend/`, `frontend/`, `api/` projects are detected too.

If a level has no command, the report lists it under **unverified with a reason** — it is never
reported as passing.

## Error classification

```
SYNTAX_ERROR · IMPORT_ERROR · DEPENDENCY_ERROR · BUILD_ERROR · RUNTIME_ERROR · TEST_FAILURE
DATABASE_ERROR · NETWORK_ERROR · CONFIGURATION_ERROR · ENVIRONMENT_ERROR · PERMISSION_ERROR
ARCHITECTURE_ERROR · UNKNOWN_ERROR
```

Each class maps to a short repair hint that is returned to the model with the failure output, so the
repair attempt starts from the real cause instead of guesswork. `UNKNOWN_ERROR` explicitly instructs
the agent to investigate output, logs, files and environment rather than hallucinate a cause.

## Repair limit

Five attempts (configurable) on the *same* failure signature. Then the agent stops, explains that the
remaining problem needs a decision, and hands control back to the user.

## No fake success

The `finish` tool is cross-checked against recorded verification runs. A claim of verified success
without a passing verification is rewritten by the application with an explicit warning, and the
completion event is marked unverified.
