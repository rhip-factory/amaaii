#!/usr/bin/env bash
set -euo pipefail
for script in scripts/smoke/[0-9][0-9]-*.sh; do
  echo "=== $script ==="
  bash "$script" || { echo "FAILED: $script"; exit 1; }
done
echo "ALL SMOKE TESTS PASSED"
