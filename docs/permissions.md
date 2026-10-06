# Permission system

## Modes

| Mode | Auto-allowed up to | Behaviour |
|---|---|---|
| `safe` | SAFE | Read-only; every mutating tool requires explicit approval |
| `balanced` (default) | LOW | Routine development runs; MEDIUM+ asks |
| `autonomous` | MEDIUM | Minimal interruption; HIGH/CRITICAL still asks, blocklist still applies |
| `custom` | configurable | Per-capability switches: deletions, remote Git, reads outside the workspace |

## Risk levels

```
SAFE      python --version, git status, pytest, npm run build
LOW       npm install, pip install, mkdir, git add, migrations
MEDIUM    git commit/checkout, mv, starting servers, docker, env changes
HIGH      deletions, recursive removal, git push/reset --hard, drop table
CRITICAL  service/scheduled-task/ACL changes — never auto-allowed
BLOCKED   disk format, shutdown, registry writes, execution-policy or firewall changes,
          credential tooling, private-key reads, `curl | bash`, fork bombs, rm -rf /
```

Chained commands (`&&`, `||`, `;`, `|`, newlines) are split and classified segment by segment; the
highest risk wins, and the blocklist is also evaluated against the whole command line.
Unrecognised commands are treated as MEDIUM, never as safe. Base64-encoded PowerShell is blocked.

## Approvals

Approval cards show operation, target, command, reason and risk, and offer
**Allow once · Allow for session · Allow for project · Deny**. Session and project grants are keyed by
tool + executable + risk, so approving `npm install` does not silently approve `rm`.
An unanswered approval times out as **deny** after 10 minutes so the agent can never hang forever.

Rules that hold in every mode, including `autonomous`:

- the blocklist is absolute;
- CRITICAL always requires explicit approval;
- remote Git operations always require explicit approval;
- all paths must resolve inside the workspace sandbox.
