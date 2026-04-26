# Shared helper for smoke scripts: POST a simulated Twilio webhook payload.
# Sourced (not executed). Honors a SMOKE_BASE_URL env override; defaults to
# http://localhost:3000.
#
# Usage:
#   source scripts/smoke/lib/send.sh
#   send "whatsapp:+254700000001" "Hi"

SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://localhost:3000}"

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
