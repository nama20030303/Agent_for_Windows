# Troubleshooting

**"Configure the AI provider API key in Settings first."**
Settings → AI provider → paste the key → *Test connection*. The key is stored encrypted and is not
readable by the UI afterwards.

**Connection test fails**
- 401/403 → wrong or unauthorised key.
- 404 → wrong Base URL or model id. The app appends `/v1` only when the URL does not already end in a
  version segment.
- Timeout → raise the timeout in Settings; large reasoning models can take minutes for long turns.

**The agent says an operation was blocked**
The command matched the absolute blocklist (see `docs/security.md`) or targeted a path outside the
workspace. Blocklisted operations cannot be enabled from the UI by design.

**Tests or builds "not verified"**
No test/build command was detected. Add a `test`/`build` script to `package.json`, a `pyproject.toml`,
etc. The agent intentionally reports *not verified* instead of claiming success.

**Port already in use**
`start_process` refuses to start and reports free alternatives; ask the agent to use one.

**A change went wrong**
Sidebar → Checkpoints → Restore. Files created after the checkpoint are listed, not deleted.

**Where are logs and data?**
`%APPDATA%\NexusCode\logs` and `%APPDATA%\NexusCode\database`. Logs are redacted of secrets.
