# Agent loop

## States

```
IDLE → ANALYZING → INSPECTING_PROJECT → ANALYZING_REQUIREMENTS
     → WAITING_FOR_USER → PLANNING → WAITING_FOR_APPROVAL
     → EXECUTING ⇄ RUNNING_TOOL → VERIFYING ⇄ REPAIRING
     → BLOCKED | STOPPING → STOPPED | COMPLETED | FAILED
```

`AgentStateMachine` (`src/core/agent/stateMachine.ts`) declares the legal transitions. Invalid
transitions are refused rather than thrown, and every state change is persisted to
`agent_state` so a crash leaves a recoverable session.

## Turn structure

```
prepareContext()        index project, build system prompt, run requirement pre-analysis
  ↓
loop (max N iterations)
  callModel()           streaming, with the mode-appropriate tool set
  ↓
  for each tool call
      dispatch()        meta tool → protocol handler
                        normal tool → ToolManager pipeline
      append result to history (wrapped as untrusted data)
  ↓
  pause if the agent asked a question, requested plan approval,
  hit the repair limit, or called finish
```

Pausing instead of blocking means the UI stays responsive and the session survives a restart:
the user's next message resumes the loop via `continueWith()`.

## Repair loop

`verify_work` runs the real project commands. On failure the controller:

1. computes a failure signature (`command:error_type`)
2. increments the counter when the same failure repeats, resets it otherwise
3. attaches `REPAIR GUIDANCE` derived from the error classification
4. after `maxRepairAttempts` (default 5) on the *same* failure, moves to `BLOCKED` and hands
   control back to the user instead of looping forever

## Interruption and live modification

- **Stop** aborts the provider request and the running child process through an `AbortController`;
  state becomes `STOPPED` and is persisted.
- A message sent while the agent is working is injected as a `USER INTERRUPTION` turn, so new
  constraints ("don't touch the frontend", "use PostgreSQL instead") are reconciled with current state
  rather than restarting the task.

## Completion honesty

`finish` cannot declare verified success by itself. The controller compares the model's claim with
the recorded verification runs; if no passing verification exists, the report is annotated and the
`completion` event carries `verified: false`.
