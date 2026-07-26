# Shared helper for smoke scripts: POST a simulated Twilio webhook payload.
# Sourced (not executed). Honors a SMOKE_BASE_URL env override; defaults to
# http://localhost:3000.
#
# Usage:
#   source scripts/smoke/lib/send.sh
#   send "whatsapp:+254700000001" "Hi"

SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://localhost:3000}"

# Poll until the server accepts connections at $1 (default SMOKE_BASE_URL),
# up to ~25s, instead of a fixed `sleep 2`. Boot time crept past 2s under
# load once the durable job worker started at boot (P4-A), making a fixed
# wait racy; polling the port is robust regardless of boot speed. Returns
# non-zero (and prints FAIL) if the server never comes up.
wait_for_server() {
  local url="${1:-${SMOKE_BASE_URL:-http://localhost:3000}}"
  local i=0
  while [ "$i" -lt 100 ]; do   # 100 * 0.25s = 25s
    if curl -s -o /dev/null "${url}/" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done
  echo "FAIL: server did not become ready at ${url} within 25s" >&2
  return 1
}

send() {
  # ${3-SmokeTest} (no colon): default only when arg UNSET, not when empty.
  # Pass an empty third arg to suppress ProfileName entirely.
  local from="$1" body="$2" profile="${3-SmokeTest}"
  # --data-urlencode preserves '+' in phone numbers (otherwise curl
  # treats '+' as URL-encoded space and the body decodes as ' ').
  # Pass profile="" to omit ProfileName entirely (some onboarding tests
  # need the bot to elicit the name rather than pre-fill from Twilio).
  if [ -n "$profile" ]; then
    curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
      --data-urlencode "From=$from" \
      --data-urlencode "Body=$body" \
      --data-urlencode "ProfileName=$profile" \
      "${SMOKE_BASE_URL}/webhook"
  else
    curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
      --data-urlencode "From=$from" \
      --data-urlencode "Body=$body" \
      "${SMOKE_BASE_URL}/webhook"
  fi
}
