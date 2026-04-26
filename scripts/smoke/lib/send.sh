# Shared helper for smoke scripts: POST a simulated Twilio webhook payload.
# Sourced (not executed). Honors a SMOKE_BASE_URL env override; defaults to
# http://localhost:3000.
#
# Usage:
#   source scripts/smoke/lib/send.sh
#   send "whatsapp:+254700000001" "Hi"

SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://localhost:3000}"

send() {
  local from="$1" body="$2"
  curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
    -d "From=$from" -d "Body=$body" -d "ProfileName=SmokeTest" \
    "${SMOKE_BASE_URL}/webhook"
}
