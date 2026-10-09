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

**The agent analysed the task, said it was finished, and the folder is empty**
Two separate faults produced this, both fixed in build 25. A Windows path written into a tool call
— `%APPDATA%\NexusCode\` or `C:\Users\me` — is not valid JSON, because `\N` and `\U` are not
legal escapes, so the entire call used to be discarded and the step silently did nothing. Lone
backslashes inside a string are now read as literal backslashes, which is the only thing they can
have meant. Separately, `finish` is no longer taken at face value: in Agent and Auto mode, a report
of success in a session that created, modified and deleted no files and ran no command is refused,
and the model is told to do the work instead. If it insists, the report says in plain words that
nothing on disk changed. Recording requirements and presenting a plan now also appear in the
activity feed, so a run that is only analysing no longer looks frozen.

**A call that looks right but does nothing (code with quotes)**
Fixed in build 22. Source code is full of quote-comma pairs - `format!("{}", x)`, `#[serde(rename =
"role")]` - and each one looks exactly like the end of a JSON string. The parser now tries every
possible end of the value and keeps the one that leaves precisely the enclosing braces behind, so a
Rust or JavaScript file survives the round trip byte for byte. Where the reading is genuinely
ambiguous, the tool's own argument names decide: a salvaged call carrying arguments the tool does
not have is refused rather than writing mangled content, and the model is asked to escape its JSON
properly.

**The model sends a command but nothing happens**
Fixed in build 20. Two shapes of almost-valid JSON were being thrown away:
- **unescaped quotes and raw newlines** inside an argument, which is what happens whenever a model
  pastes source code (`println!("hi")`) into `content`. The call is now parsed key by key, trying
  each plausible end of the string and keeping the one the rest of the object agrees with;
- **a reply cut off mid-JSON** by the output limit. Such a call is detected but deliberately **not
  run** — writing half a file is worse than writing none. The model is told its call was truncated
  and asked to build the file from several smaller calls (about 150 lines each), and the run
  continues.

**The agent explains the work instead of doing it**
The app escalates on its own, inside a single turn:
1. normal request with native function calling;
2. if no call comes back, the tools and the `tool_call` format go into the prompt together with a
   worked example exchange, the model is shown its own failed answer and asked again;
3. if it still will not comply, the block is opened for it (`\`\`\`tool_call` + `{`) so the only thing
   left to produce is the JSON.
Replies are parsed leniently — raw newlines inside strings, trailing commas, a missing closing fence,
wrapper objects, the legacy `function_call` field — and common wrong names (`create_file`,
`run_command`, `ls`, `done`) are mapped to the real tools. If the model invents a name that cannot be
mapped, it is told which tools exist and asked to repeat the call. Only after all of that does a run
stop as BLOCKED, and the message then quotes what the model actually said.

**Old note: the agent explains the work instead of doing it**
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

**Nothing comes back, whatever the app tries**
Open Settings and press **"Find a working model"**. The app asks the endpoint for its real catalogue
(`GET /v1/models`), tries the configured model first and then the most promising ones, on both
`/v1/chat/completions` and `/v1/responses`, and keeps the first combination that produces text —
saving it to your settings. A gateway answers a request for a model it does not host with a polite
empty completion, so this is usually the whole problem: the model name is not one the provider
routes anywhere.

If every model comes back empty, the endpoint hosts nothing for your key: check the balance and the
key's permissions in the provider dashboard.

**The provider answers with silence**
The app looks for a request shape the endpoint will answer, in this order, and remembers what worked:
1. the textual tool protocol (when tools were in play);
2. the same request with **no `max_tokens` field at all** — several gateways return an empty
   completion when the value is above what the model allows;
3. a reduced request: system prompt, the last few messages and only the essential tools.

**Max tokens** is now **0 by default, meaning no limit**: a reasoning model spends an unpredictable
share of its budget thinking, and a limit that is too low (or too high for the gateway) is the most
common reason for an empty answer. Existing installs are migrated to 0 once; set a number if you
want a hard cap.

**Old note: the provider returns an empty response**
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
