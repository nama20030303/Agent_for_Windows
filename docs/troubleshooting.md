# Troubleshooting

**"Configure the AI provider API key in Settings first."**
Settings → AI provider → paste the key → *Test connection*. The key is stored encrypted and is not
readable by the UI afterwards.

**Pre-configuring the key without the UI**
Set `NEXUS_CODE_API_KEY` (optionally `NEXUS_CODE_BASE_URL`, `NEXUS_CODE_MODEL`) before launching, or
create `%APPDATA%\NexusCode\config\bootstrap.json`:

```json
{ "apiKey": "sk-...", "baseUrl": "https://your-endpoint/v1", "model": "am/nemotron-3-ultra-550b-a55b" }
```

On the next launch the key is imported into the encrypted store, onboarding is skipped and the
plaintext file is wiped. An existing stored key is never overwritten.

**The agent shows the requirement analysis and then nothing happens**
The endpoint accepted the request but returned no answer. Nexus Code now retries once and then tells
you why. The usual causes:
- *Reasoning model, low token ceiling* — the model spends its budget on internal reasoning and never
  reaches an answer. Raise **Max tokens** in Settings to 16000 or more (this is now the default).
- *No tool-calling support* — the model must support OpenAI-style function calling. Check the
  provider's model card.
- *Wrong base URL* — a host that answers 200 with a different payload shape yields empty replies.
  Use *Test connection*.

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
