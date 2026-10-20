#!/usr/bin/env bash
# Run every persona x arm in parallel. Usage:
#   scripts/sim/runAll.sh <runName> "<arms, e.g. H S>" [concurrency] [maxBeats] [personas...]
set -euo pipefail
cd "$(dirname "$0")/../.."
# OPENROUTER_API_KEY (or SIM_OPENROUTER_API_KEY) comes from SIM_ENV_FILE (default ./.env).
export SIM_ENV_FILE=${SIM_ENV_FILE:-.env}
RUN=${1:?runName}; ARMS=${2:-"H S"}; CONC=${3:-6}; MAXB=${4:-999}
# Anything after the 4th argument is a persona filter.
if [ $# -gt 4 ]; then shift 4; else set --; fi
PERSONAS=${*:-$(node_modules/.bin/tsx -e "import {PERSONAS} from './scripts/sim/personas'; console.log(PERSONAS.map(p=>p.id).join(' '))")}
OUT="sim-runs/$RUN"; mkdir -p "$OUT"
export SIM_BASELINE_USAGE=${SIM_BASELINE_USAGE:-$(node -e 'require("dotenv").config({path:process.env.SIM_ENV_FILE||".env",quiet:true});const k=process.env.SIM_OPENROUTER_API_KEY||process.env.OPENROUTER_API_KEY;fetch("https://openrouter.ai/api/v1/key",{headers:{Authorization:"Bearer "+k}}).then(r=>r.json()).then(j=>console.log(j.data.usage))')}
echo "baseline usage: $SIM_BASELINE_USAGE" | tee "$OUT/baseline.txt"
JOBS=()
for a in $ARMS; do for p in $PERSONAS; do JOBS+=("$p $a"); done; done
printf '%s\n' "${JOBS[@]}" | xargs -P "$CONC" -L 1 bash -c '
  p=$0; a=$1; d="'"$OUT"'/$a/$p"; mkdir -p "$d"
  node_modules/.bin/tsx scripts/sim/runPersona.ts "$p" "$a" "$d" '"$MAXB"' >"$d/app.log" 2>"$d/progress.log" || echo "FAILED $p $a ($?)" >>"'"$OUT"'/failures.txt"
  tail -1 "$d/progress.log"'
echo "all done"
