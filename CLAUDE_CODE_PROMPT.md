# 🚀 COPY THIS PROMPT TO CLAUDE CODE 🚀

```
Hi! I need you to build the foundational backend for Amaaii, a WhatsApp-based maternal health chatbot for pregnant and postpartum mothers in Kenya.

CONTEXT:
Amaaii is a platform designed to reduce maternal mortality in Kenya (currently 342 per 100,000 live births) through:
- AI-powered pregnancy journaling via WhatsApp
- Early detection of pregnancy complications and danger signs
- ANC visit reminders and health tracking
- Mental health support and postpartum care
- Connection to Community Health Workers

TARGET USERS:
Pregnant and postpartum women in Kenya, particularly in underserved communities with limited healthcare access, basic smartphone skills, intermittent connectivity, and limited tech literacy.

TECHNICAL REQUIREMENTS:

**Stack:**
- Backend: FastAPI (Python 3.10+)
- Database: PostgreSQL (with JSONB for flexible medical data)
- AI: Anthropic Claude API integration (for symptom analysis and conversations)
- Messaging: WhatsApp Business API (webhook-based, reactive mode)
- Scheduler: APScheduler (for automated reminders)

**Core Features to Build:**
1. WhatsApp webhook integration (POST /webhooks/whatsapp for messages, GET for verification)
2. User management with comprehensive maternal health profiles
3. Structured onboarding flow (consent, basic info, medical history, pregnancy details)
4. Daily journaling system with AI-powered symptom analysis
5. Risk stratification (low/medium/high based on medical history)
6. Danger sign detection and urgent alert system
7. ANC visit scheduling and reminder system
8. Message template management (for WhatsApp 24-hour window)
9. Conversation state machine for multi-step interactions
10. Background task scheduler for automated check-ins

**Database Models Needed:**

User Model:
- id (UUID primary key), phone_number (unique), whatsapp_id, name, age, language_preference (en/sw)
- location_county, consent_given, consent_date, registration_date
- onboarding_completed, current_onboarding_step, is_active
- risk_category (low/medium/high), assigned_chw_id, last_interaction

Pregnancy Model:
- id, user_id (foreign key), lmp_date, edd_date, gestational_age_weeks, gestational_age_days
- gravida, parity, is_current, pregnancy_status, delivery_date, birth_outcome (JSONB)
- multiple_pregnancy, number_of_fetuses

MedicalHistory Model:
- id, user_id (foreign key, unique), chronic_conditions (JSONB), previous_complications (JSONB)
- previous_delivery_modes (JSONB), previous_stillbirths, previous_miscarriages
- hiv_status, on_pmtct, blood_type, allergies (JSONB), current_medications (JSONB)
- family_history (JSONB), mental_health_history (JSONB)
- smoking_status, alcohol_use, domestic_violence_screening (JSONB)

JournalEntry Model:
- id, user_id, pregnancy_id, entry_date, entry_time
- raw_message (text), processed_content (JSONB), ai_analysis (JSONB)
- sentiment_score, mood_category, danger_signs_flagged, requires_urgent_attention
- provider_notified

RiskAssessment Model:
- id, user_id, pregnancy_id, assessment_date
- risk_category, risk_factors (JSONB), risk_score
- assessment_type (initial/periodic/symptom_triggered)
- recommendations (JSONB), follow_up_required, follow_up_date
- assessed_by (ai/provider/system)

ANCVisit Model:
- id, user_id, pregnancy_id, visit_number, scheduled_date, completed_date
- visit_status (scheduled/completed/missed/rescheduled)
- gestational_age_at_visit, facility_name, provider_id
- visit_notes (JSONB), next_visit_date, reminder_sent

Message Model:
- id, user_id, whatsapp_message_id, direction (incoming/outgoing)
- message_type (text/template/interactive/image/voice)
- content, template_name, metadata (JSONB), conversation_context
- is_automated, sent_at, delivered_at, read_at, failed, failure_reason

Provider Model:
- id, name, provider_type (chw/nurse/midwife/doctor/facility)
- phone_number, email, facility_name, county
- is_active, can_receive_alerts

**Project Structure:**
```
amaaii-backend/
├── app/
│   ├── main.py                 # FastAPI app
│   ├── config.py               # Environment config
│   ├── database.py             # DB connection
│   ├── models/                 # SQLAlchemy models
│   │   ├── __init__.py
│   │   ├── user.py
│   │   ├── pregnancy.py
│   │   ├── journal_entry.py
│   │   ├── medical_history.py
│   │   ├── risk_assessment.py
│   │   ├── anc_visit.py
│   │   ├── message.py
│   │   └── provider.py
│   ├── schemas/                # Pydantic schemas
│   │   ├── __init__.py
│   │   ├── user.py
│   │   ├── pregnancy.py
│   │   ├── journal.py
│   │   ├── medical_history.py
│   │   └── whatsapp.py
│   ├── api/                    # Route handlers
│   │   ├── __init__.py
│   │   ├── webhooks.py         # WhatsApp webhooks
│   │   ├── users.py
│   │   ├── journaling.py
│   │   └── health.py
│   ├── services/               # Business logic
│   │   ├── __init__.py
│   │   ├── whatsapp_service.py
│   │   ├── ai_service.py
│   │   ├── risk_service.py
│   │   ├── onboarding_service.py
│   │   ├── journaling_service.py
│   │   ├── reminder_service.py
│   │   └── template_service.py
│   ├── core/                   # Utilities
│   │   ├── __init__.py
│   │   ├── security.py
│   │   ├── conversation_state.py
│   │   └── constants.py
│   └── utils/
│       ├── __init__.py
│       ├── validators.py
│       ├── formatters.py
│       └── language.py
├── alembic/                    # DB migrations
│   ├── versions/
│   └── env.py
├── tests/
├── .env.example
├── .gitignore
├── requirements.txt
├── alembic.ini
└── README.md
```

**Critical Implementation Details:**

1. **WhatsApp Webhook Handler (webhooks.py):**
   - GET endpoint for webhook verification (returns challenge token)
   - POST endpoint to receive messages
   - Verify webhook signature from Meta
   - Parse incoming message payload (extract sender, text, timestamp)
   - Identify or create user
   - Determine conversation state
   - Route to appropriate handler
   - Return 200 OK immediately

2. **Conversation State Machine (conversation_state.py):**
   States: NEW_USER, CONSENT_PENDING, BASIC_INFO, MEDICAL_HISTORY, OBSTETRIC_HISTORY, PREGNANCY_DETAILS, RISK_ASSESSMENT, ONBOARDING_COMPLETE, DAILY_JOURNAL, SYMPTOM_INQUIRY, DANGER_SIGN_PROTOCOL, ANC_REMINDER_RESPONSE, MENTAL_HEALTH_CHECK
   
   Store current state in User.current_onboarding_step
   Each state has specific prompts and expected responses

3. **AI Service (ai_service.py):**
   Functions:
   - analyze_journal_entry(text, user_context) → Returns: structured symptoms, mood, danger signs, recommendations, supportive response
   - generate_response(message, context, profile) → Empathetic, culturally appropriate response
   - assess_mental_health(entries, profile) → Depression screening
   - create_onboarding_prompt(step, responses) → Next question in flow
   
   System Prompt: "You are Amaaii, a compassionate maternal health assistant for pregnant mothers in Kenya. Provide emotional support, identify health risks, guide on care-seeking. Use simple language, be culturally sensitive, never diagnose/prescribe, always prioritize safety."

4. **Risk Assessment Service (risk_service.py):**
   HIGH RISK: Age <18 or >35, previous pre-eclampsia, chronic hypertension, HIV+, multiple pregnancy
   MEDIUM RISK: Age 18-20, previous preterm birth, anemia, primigravida
   LOW RISK: Age 21-31, no complications, normal history
   
   Functions:
   - calculate_risk_score(medical_history, pregnancy_data)
   - categorize_risk(risk_score)
   - generate_recommendations(risk_category)

5. **Danger Signs (constants.py):**
   Critical symptoms requiring urgent care:
   - Severe bleeding, severe headache + vision changes, severe abdominal pain
   - Fever >38°C, convulsions, severe swelling, water breaking before 37 weeks
   - No fetal movement 12+ hours, suicidal ideation
   
   When detected: Send urgent message, notify CHW, flag in database

6. **WhatsApp Service (whatsapp_service.py):**
   Functions:
   - send_text_message(phone_number, text)
   - send_template_message(phone_number, template_name, parameters)
   - validate_phone_number(number)
   
   Handle 24-hour window: Can send free text within 24 hours of user's last message, otherwise must use templates

7. **Onboarding Service (onboarding_service.py):**
   Stages:
   1. Welcome & Consent (explain platform, request consent)
   2. Basic Info (name, age, location, language)
   3. Current Pregnancy (LMP/EDD, gravida, parity)
   4. Medical History (chronic conditions, past complications)
   5. Risk Assessment & Personalization
   
   One question at a time, validate inputs, allow skip for sensitive questions

8. **Reminder Service (reminder_service.py):**
   - schedule_anc_reminder(anc_visit) - Send 3 days before, 1 day before
   - schedule_daily_checkin(user) - Send at preferred time if no message that day
   - Background job to send scheduled reminders

**Environment Variables (.env.example):**
```
APP_NAME=Amaaii
ENVIRONMENT=development
DEBUG=true
SECRET_KEY=<to-be-generated>

DATABASE_URL=postgresql://user:password@localhost:5432/amaaii_db

# WhatsApp (to be filled after Meta setup)
WHATSAPP_API_URL=https://graph.facebook.com/v18.0
WHATSAPP_ACCESS_TOKEN=<from-meta>
WHATSAPP_PHONE_NUMBER_ID=<from-meta>
WHATSAPP_BUSINESS_ACCOUNT_ID=<from-meta>
WEBHOOK_VERIFY_TOKEN=<custom-secret>

# Claude API (to be filled later)
ANTHROPIC_API_KEY=<from-anthropic>
ANTHROPIC_MODEL=claude-sonnet-4-20250514

TIMEZONE=Africa/Nairobi
LOG_LEVEL=INFO
```

**Code Quality Requirements:**
- Proper error handling (all webhooks return 200 OK)
- Structured logging (JSON format, include request IDs)
- Input validation (Pydantic schemas)
- Database indexes on frequently queried fields
- Async processing for long-running tasks
- Comprehensive docstrings
- Type hints throughout
- Security: Encrypt sensitive data, hash phone numbers, implement consent management

**IMPORTANT NOTES:**
- This is MVP foundation - no frontend UI needed (WhatsApp is the interface)
- Templates need Meta approval before use (prepare but don't implement sending yet)
- AI API key and WhatsApp credentials will be added later
- Focus on clean, production-ready code

**Deliverables:**
1. Complete project structure with all files
2. All database models with relationships and migrations
3. WhatsApp webhook handlers (ready for credentials)
4. AI service integration (ready for API key)
5. Complete onboarding flow implementation
6. Journaling with AI analysis
7. Risk assessment and danger sign detection
8. ANC reminder scheduling
9. Conversation state management
10. Configuration and environment setup
11. Requirements.txt with dependencies
12. Comprehensive README.md with setup instructions
13. Alembic migrations set up

Please build this complete foundational backend following best practices. Ask clarifying questions if needed before building.
```

---

## After Claude Code Builds:

1. **Review the generated code** - Check all components
2. **Set up local environment** - Install dependencies, create database
3. **Run migrations** - `alembic upgrade head`
4. **Start server** - `uvicorn app.main:app --reload`
5. **Test health endpoint** - Visit http://localhost:8000/docs
6. **Set up Meta WhatsApp** - Follow amaaii_quick_start.md
7. **Get Claude API key** - Follow amaaii_quick_start.md
8. **Test end-to-end** - Send test messages via WhatsApp

---

*This prompt is optimized for Claude Code (Agentic Coding Assistant)*  
*Copy the entire block above and paste into Claude Code to generate all backend code*
