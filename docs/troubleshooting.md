# Troubleshooting

**You do not know which Base URL belongs to your key**
Paste the key and press **Find my provider automatically** (onboarding) or **Detect endpoint**
(Settings). Nexus Code asks each known OpenAI-compatible host whether it accepts the key and which
models it serves, then fills in the endpoint and the exact model id that host uses — the same model
is called `am/…`, `nvidia/…` or `…:free` depending on the provider. The per-host answers are listed,
so a rejected key is distinguishable from an unreachable host.

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

**The agent explains the work instead of doing it**
Handled automatically. When a reply in Agent or Auto mode contains no tool call, the app assumes the
endpoint cannot do function calling: it drops the `tools` parameter, puts the tool list and the
`tool_call` format into the prompt, shows the model its own failed attempt and retries. From then on
the whole session uses that textual protocol, and blocks the model emits are parsed back into real
calls — including sloppy ones with raw newlines inside strings, trailing commas or a missing
language tag. Only if the model ignores that too does the run stop as BLOCKED, and it never reports
success for work it did not do.

**Old note: the agent explains the work instead of doing it, then says it finished**
The model is not emitting tool calls, so nothing reaches the filesystem. Nexus Code no longer reports
such a turn as completed: it asks the model once to use tools, then stops with **BLOCKED** and says
so. Two ways forward:
- *Preferred:* use a model your provider advertises with **function calling / tools**. Press
  **Test connection** — it now probes a real tool call and tells you whether the endpoint supports it.
- *Fallback:* the agent also accepts a textual call, so a model without native support can still act:
  ```tool_call
  { "tool": "write_file", "arguments": { "path": "snake.py", "content": "..." } }
  ```
  This is less reliable, since it depends on the model following the format.

**The agent explains the work instead of doing it, then says it finished**
The model is not emitting tool calls, so nothing reaches the filesystem. Nexus Code no longer reports
such a turn as completed: it asks the model once to use tools, then stops with **BLOCKED** and says
so. Two ways forward:
- *Preferred:* use a model your provider advertises with **function calling / tools**. Press
  **Test connection** — it now probes a real tool call and tells you whether the endpoint supports it.
- *Fallback:* the agent also accepts a textual call, so a model without native support can still act:
  a fenced `tool_call` block containing `{ "tool": "write_file", "arguments": { ... } }`.
  This is less reliable, since it depends on the model following the format.

**The provider returns an empty response**
Nexus Code now handles the most common cause itself: some endpoints accept the `tools` parameter and
then reply with nothing. When that happens the app drops `tools`, describes them inside the prompt and
retries, driving the model through its textual `tool_call` protocol for the rest of the session. You
will see this in **Test connection** as "switched to its textual tool protocol automatically".
If the reply is still empty after that, the endpoint is reachable but the request never produces
output — raise **Max tokens** to 16000 or more (reasoning models spend most of their budget thinking),
and confirm the model name is exactly the one the provider exposes.

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
