# Tool system

Every tool is `{ definition, describe(args), execute(args, ctx) }`. Definitions carry a JSON schema,
a category, a baseline risk level and a `mutating` flag used by read-only modes.

## Pipeline

```
model tool call
  → tool exists?
  → arguments validated against the schema (unknown properties rejected)
  → path arguments resolved and contained in the workspace
  → command classified for risk, hard blocklist applied
  → permission check (mode, grants, approval card)
  → execute
  → structured ToolResult { success, exit_code, stdout, stderr, duration_ms, error_type }
```

## Catalogue

| Category | Tools |
|---|---|
| Filesystem | `list_directory`, `read_file`, `write_file`, `edit_file`, `create_directory`, `delete_file`, `move_file`, `copy_file`, `file_exists`, `get_file_info` |
| Search | `search_files`, `search_text`, `find_symbol`, `find_references` |
| Terminal | `execute_command` |
| Process | `start_process`, `stop_process`, `list_processes`, `get_process_output`, `http_check` |
| Git | `git_status`, `git_diff`, `git_log`, `git_branch`, `git_add`, `git_commit`, `git_checkout`, `git_pull`, `git_push` |
| Testing | `detect_test_framework`, `run_tests`, `run_build`, `run_linter`, `run_formatter` |
| Meta (protocol) | `record_requirements`, `ask_user`, `present_plan`, `update_task`, `verify_work`, `create_checkpoint`, `remember`, `finish` |

## Design notes

- **`write_file` is atomic**: content is written to a temp file in the same directory and renamed, so
  an interrupted write cannot truncate an existing file.
- **`edit_file` refuses ambiguity**: a missing or multiply-matching `old_text` is an error, never a
  silent rewrite. Every mutation returns a unified diff and +/- counts.
- **`execute_command` is for one-shot commands**; servers belong to `start_process`, which tracks
  pid, status, port and streaming output and can be stopped from the UI.
- **`http_check` only accepts localhost URLs** — it exists for runtime verification, not for network access.
- **Adding a tool**: implement it with `defineTool`, export it from a category module and add it to
  `allTools()`. Risk and `mutating` drive the permission system automatically. Future browser,
  database, Docker and SSH tools slot in the same way.
