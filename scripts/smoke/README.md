# Smoke Test Harness

Shell-based end-to-end checks that exercise a running Amaaii server. They complement the vitest unit tests (`pnpm test`) but **are not** run by vitest — they spawn processes, hit HTTP endpoints, and touch the filesystem.

## Conventions

- Scripts are named `NN-<workstream>.sh`, numbered to match the §7 workstream they belong to (so `03-danger-signs.sh` lives with workstream 7.3).
- Every script is idempotent: it cleans up temp files and background processes, removes `amaaii.db` when needed, and exits with a non-zero status on any failure (`set -euo pipefail`).
- Successful scripts print a single line starting with `PASS:`. Anything else is treated as failure by `run-all.sh`.
- Scripts are executable (`chmod +x`). They are invoked with `bash scripts/smoke/<name>.sh`.

## Running

Single script:

```bash
bash scripts/smoke/00-server-boot.sh
```

All scripts in sequence:

```bash
bash scripts/smoke/run-all.sh
```

## Per-workstream inventory

| Script | Workstream | Introduced in |
|--------|------------|---------------|
| `00-server-boot.sh` | 7.1 repo-hygiene | this branch |
| `02-pii-and-webhook.sh` | 7.2 pii-and-webhook | later |
| `03-danger-signs.sh` | 7.3 danger-sign-regex | later |
| `04-onboarding-order.sh` | 7.4 onboarding-order | later |
| `05-journal-persistence.sh` | 7.5 journal-persistence | later |
| `06-parsers-and-upsert.sh` | 7.6 dead-code-and-parsers | later |

A shared helper `lib/send.sh` is added during workstream 7.4 (see spec §13.1).
