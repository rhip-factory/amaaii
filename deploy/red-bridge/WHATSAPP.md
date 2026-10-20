# WhatsApp (Meta Cloud API): runbook

Production WhatsApp runs on Meta's WhatsApp Cloud API directly, with no BSP in between. It went live on
2026-10-20 (PR #16). The code side is described in `CLAUDE.md` → "WhatsApp transports". This file covers
the Meta account: what exists, where the secrets live, and how to check, change, or roll back.

None of the IDs below are secrets: they do nothing without the access token or the app secret. **Never
add a secret value to this file**, only the name of the variable that holds it.

## Accounts and IDs

| What | Value |
|---|---|
| Public number | **+254 180 942592** (0180 942 592) |
| Phone number ID | `1374267975772299` (= `META_WA_PHONE_NUMBER_ID`) |
| WhatsApp Business Account (WABA) | "Amaaii", `1817052529308029` |
| Display name | "Amaaii" (status `AVAILABLE_WITHOUT_REVIEW`, see limits below) |
| Business portfolio | "Amaaii", `2068466000435221`, **not business-verified** |
| Meta app | "Amaaii", app ID `1586071899728837`, Live mode |
| System user | `amaaii-server` (Admin), owns the production access token |
| Webhook | `https://amaaii.com/webhook/meta` |
| Webhook fields | `messages`, `account_alerts`, `account_update`, `message_template_status_update`, `phone_number_name_update`, `phone_number_quality_update`, `security` |
| OTP template | `amaaii_otp`, AUTHENTICATION, `en`, copy-code button, 10-minute expiry, template ID `2299797053893419` |

Meta's own test setup is kept for local testing. Don't delete it.

| What | Value |
|---|---|
| Test WABA | "Test WhatsApp Business Account", `2022953138425239` |
| Test number | +1 555-615-5969, phone number ID `1327684127095802` |

## Where the secrets live

| Secret | Where |
|---|---|
| `META_WA_ACCESS_TOKEN` | red-bridge `/srv/amaaii/app/.env`. A System User token that never expires, with scopes `whatsapp_business_management`, `whatsapp_business_messaging`, `whatsapp_business_manage_events`. Regenerate it in Business settings → Users → System users → `amaaii-server`. |
| `META_APP_SECRET` | red-bridge `.env`. Found in the app dashboard → App settings → Basic. It verifies `X-Hub-Signature-256`. |
| `META_WEBHOOK_VERIFY_TOKEN` | red-bridge `.env`. Random, generated on the box. It must match what Meta's webhook config was given. |
| Two-step verification PIN | The owner's password manager, and their local `.env` as `META_WA_PIN`. Not needed on the server. Anyone who has it can re-register the number elsewhere. |

Check a secret on the box without printing it:
`awk -F= '/^META_WA_ACCESS_TOKEN=/{print length($2), substr($2,1,3)}' .env`
should print `200 EAA`.

## Limits while unverified

- **250 unique users per rolling 24h** for business-initiated messages: templates sent outside a
  customer-service window. For us that means PWA sign-in codes for people who haven't messaged the bot
  that day. Replies inside the 24h window don't count and have no cap. Two ways to raise the limit to
  2,000: complete business verification, or deliver 2,000 high-quality template messages to unique users
  within 30 days.
- **The display name is not shown in chat headers or the chat list.** Users see the bare number until
  Meta reviews the name, which happens after verification or a higher limit. The bot mitigates this by
  asking new users to save the number as "Amaaii" (the `consent_thanks` copy).
- **At most 2 registered numbers** per portfolio. The cap rises to 20 after verification.
- **No green tick** (Official Business Account) without verification.

## Checking things

These are run from a machine whose `.env` has the token. Every example reads `$META_WA_ACCESS_TOKEN`
and `$META_APP_SECRET` from the environment, so no value appears on the command line.

```sh
G=https://graph.facebook.com/v23.0
AUTH="Authorization: Bearer $META_WA_ACCESS_TOKEN"

# Number: expect status CONNECTED, platform_type CLOUD_API
curl -s "$G/1374267975772299?fields=display_phone_number,status,platform_type,quality_rating,name_status,whatsapp_business_manager_messaging_limit" -H "$AUTH"

# Template review: PENDING / APPROVED / REJECTED (+ rejected_reason)
curl -s "$G/2299797053893419?fields=name,status,rejected_reason" -H "$AUTH"

# The WABA must list the Amaaii app, or no inbound messages arrive
curl -s "$G/1817052529308029/subscribed_apps" -H "$AUTH"

# Where Meta sends webhooks, and which fields (uses the app token appid|secret)
curl -s "$G/1586071899728837/subscriptions" -G --data-urlencode "access_token=1586071899728837|$META_APP_SECRET"
```

Production logs: `ssh amaaii@151.115.89.219 journalctl -u amaaii-api -f -o cat`. Lines to look for:
- `Received message`
- `Message sent successfully`
- `WhatsApp delivery failed` (code `131047` = free-form text sent outside the 24h window)
- `WhatsApp Cloud API unreachable, retrying` (a network blip; sends retry twice)

## Gotchas we hit setting this up

- **The WABA was not subscribed to the app.** The dashboard flows don't do it reliably. Without it, the
  webhook gets no events at all. Fix: `POST $G/{WABA_ID}/subscribed_apps`. Do this for every new WABA.
- **"Verify and save" on the webhook page left the subscription with no fields.** Set the fields with
  `POST $G/{APP_ID}/subscriptions` (`object=whatsapp_business_account`, `callback_url`, `verify_token`,
  `fields=…`), using the app token `{APP_ID}|{APP_SECRET}`. Meta performs the GET handshake against
  the callback during that call, so the server must already be running the code that answers it.
- **The test WABA can't hold real numbers.** "Add phone number" is greyed out there. A real number is
  added from the app dashboard → WhatsApp → Production setup → "Add new number", which creates a new WABA.
- **The dashboard's temporary token expires at midnight UTC,** not after 24h. Production uses the System
  User token. Check its expiry: `curl -s "$G/debug_token?input_token=$META_WA_ACCESS_TOKEN" -H "$AUTH"`
  should show `expires_at: 0`.
- **Registering a number** is `POST $G/{PHONE_NUMBER_ID}/register` with
  `{"messaging_product":"whatsapp","pin":"<6 digits>"}`. Attempts are rate-limited, so check the PIN
  before sending.
- **Never install WhatsApp on the number.** A number on the Cloud API can't also be used in the
  WhatsApp app. Keep the SIM active (topped up): an inactive line can be recycled to someone else, and
  re-verifying the number needs SMS.

## Cutover and rollback

The cutover (done 2026-10-20) and any future move work the same way: settings first, then code, then
the webhook.

1. Back up `.env` on red-bridge and confirm the backup with `cmp`. Then add `WHATSAPP_PROVIDER=meta`,
   `META_WA_PHONE_NUMBER_ID`, `META_WA_ACCESS_TOKEN`, `META_APP_SECRET`, a fresh
   `META_WEBHOOK_VERIFY_TOKEN`, and `META_WA_OTP_TEMPLATE=amaaii_otp` once the template is approved.
2. Deploy or restart (`sudo systemctl restart amaaii-api`).
3. Point the app webhook at `https://amaaii.com/webhook/meta` with the same verify token. Check that a
   GET with a wrong token returns 403 and an unsigned POST returns 403.
4. Message the number from a phone and watch the log.

**Rollback:** set `WHATSAPP_PROVIDER=twilio` in `.env` and restart. `/webhook/meta` then ignores inbound
messages, and replies go out through Twilio again. To bring the login page's sandbox "join" notice back,
restore `SANDBOX_JOIN` in `apps/web/src/app/login/page.tsx` (the old value is in the comment there),
which needs a deploy.
