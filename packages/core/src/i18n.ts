// Hand-written EN + SW (Kiswahili) strings for every canned bot
// response. Free conversation still goes through the LLM, which we
// hint with the user's language (see services/amaaii.js).
//
// Translation principles:
// - Warm, conversational, short. Same tone in both languages.
// - Kiswahili: standard "sanifu" register, polite second person,
//   gender-neutral. Common in Kenya for maternal/health content.
// - Variables in {curly}. The render() helper substitutes them.
// - Keep the 💚 emoji etc. — they translate.

import type { Lang, Urgency } from './types';

type StringDict = Record<string, string>;

export const STRINGS: Record<Lang, StringDict> = {
  en: {
    // Onboarding
    name_prompt: "Hello! 👋 I'm Amaaii, your pregnancy companion. I'm here to support you throughout your pregnancy journey.\n\nWhat's your name? You can call me by any name you're comfortable with.",
    name_thanks: "Thank you {name}! 💚 To provide you with the best support, could you tell me your age?",
    age_thanks: "Thank you! How far along is your pregnancy? 🤰 You can say weeks or months (e.g. \"20 weeks\" or \"5 months\"), or the date your last period started. If your baby is already born, just tell me when.",
    age_prompt_again: "Thank you {name}! 💚 To provide you with the best support, could you tell me your age?",
    age_prompt_retry: "Sorry, I didn't get your age. How old are you? Just the number is fine, e.g. 24.",
    age_prompt_profile: "Nice to meet you, {name}! 💚 (If you'd like me to call you something else, just say \"call me …\".) How old are you?",
    location_prompt_again: "Which town or area do you live in? (e.g. Kibera, Nakuru, Kisumu) It helps me point you to the nearest clinic.",
    postpartum_thanks: "Congratulations on your baby! 💚 I'll support you through these early weeks.\n\nWhere are you located? (This helps me suggest nearby health facilities when needed)",
    // "at week {weeks}" rather than "{weeks} weeks along" so the copy stays
    // grammatical for every value the parser can now produce — the old
    // wording rendered "You're 1 weeks along", and week 0 is valid too.
    week_thanks: "Great! You're at week {weeks}. 🤰\n\nWhere are you located? (This helps me suggest nearby health facilities when needed)",
    week_lmp_thanks: "Based on your last period, you're at about week {weeks}. Your expected delivery date is around {edd}.\n\nWhere are you located? (This helps me suggest nearby health facilities when needed)",
    week_prompt_again: "I didn't catch that — no problem! Any of these works:\n• Weeks: \"22\" or \"22 weeks\"\n• Months: \"5 months\"\n• Your last period: \"22 March\"\n• Not sure? Your clinic card (the mother & child booklet) has your due date written on it.\nIf your baby is already born, tell me when.",
    location_done: "Perfect! I now have your basic information:\n{summary}\n\nYou can:\n• Share how you're feeling today\n• Ask me any pregnancy questions\n• Tell me about any symptoms you're experiencing\n• Type \"help\" to see what I can do\n\nHow are you feeling today? 💚",
    welcome_back: "Welcome back {name}! How can I help you today?",

    // Consent (P3-B, Kenya DPA) — asked BEFORE profile onboarding for a
    // brand-new WhatsApp user (or a returning user whose consent lapsed).
    // Danger signs still escalate during this phase (see dangerCopy
    // prepending in messageHandler.ts); these strings are only ever
    // shown for non-critical turns.
    consent_request: "Before we begin, I need your permission to store and use your messages so I can support you 💚 Amaaii keeps your chats and check-ins securely, personalises your care, and automatically watches for urgent danger signs — even before you finish signing up. Read our privacy notice: {url}\n\nReply *I AGREE* to continue, or *STOP* if you'd rather not.",
    consent_reprompt: "I didn't quite catch that. To use Amaaii, please reply with the word *AGREE* (or *I AGREE*) to accept our privacy notice and continue — I'll always alert you to urgent danger signs either way. Read the notice here: {url}\n\nOr reply *STOP* if you don't wish to continue.",
    // Reply to a question about the consent request ("what is this?",
    // "before I agree, where is the notice?"). Must keep the reprompt
    // marker phrase so the stateless gate still recognises its own prompt.
    consent_explain: "Good questions 💚 Straight answers:\n• I'm an automated assistant (a computer program), not a person or a nurse.\n• Amaaii is a pregnancy support service run by the Amaaii team. Your clinic and nurses can't see your messages.\n• To answer you and remember your due date, check-ins and questions, I need to save your messages. We never sell them, and you can ask us to delete everything at any time.\nFull notice: {url}\n\nWhen you're ready, please reply with the word *AGREE* (or *I AGREE*). If you'd rather not, reply *STOP*.",
    consent_explain_more: "More detail 💚\n• What's saved: your messages, your due date or weeks, your check-ins, and any health history you tell me.\n• Who sees it: only you and the Amaaii team. A clinic sees your record only if you separately choose to share it.\n• You stay in control: you can see, download or delete everything in the Amaaii app (Profile → Privacy & data), or just ask.\n• Want a person? The nurse who gave you this number can answer questions about Amaaii too.\nNotice: {url}\n\nIf that's okay, please reply with the word *AGREE* — or *STOP* if not.",
    // After STOP / "I don't agree". Keeps the consent_request marker so a
    // later "I AGREE" still grants straight away.
    consent_declined: "Okay, no problem — I won't sign you up or use your messages to support you. 💚 I will still always tell you if a message sounds like a danger sign. If you change your mind, Reply *I AGREE* to continue.",
    consent_thanks: "✅ Thank you — you're all set on privacy.\n\n📇 Please save this number in your contacts as *Amaaii*, so you always know a message is from us.\n\nLet's get to know you a little.",

    // Consent — web /chat (PWA) copy. Returned alongside consentRequired:
    // true instead of processing the message.
    web_consent_required: "You need to accept Amaaii's data consent before I can chat with you. Please accept it on the consent screen (also under Profile → Privacy & data) to continue — I'll still flag any urgent symptoms you mention.",

    // AI declined (ai_responses purpose not active) — deterministic
    // stand-in for what would have been an AI reply. Danger detection and
    // journaling are unaffected; this string only replaces the
    // getAmaaiiResponse() call site.
    ai_off_reply: "AI-powered replies are turned off. You can turn them on in the Amaaii app under Profile → Privacy & data. I can still help you track your check-ins and will always flag urgent symptoms.",

    // Journal
    journal_greeting: "Let's do your daily check-in! 📝\n\nFirst, how are you feeling emotionally today? (Rate 1-10, where 1 is very low and 10 is excellent)",
    journal_continue: "Welcome back! Let's continue your daily check-in 📝\n\nHow are you feeling emotionally right now? (1-10)",
    journal_yesterday_followup_one: "Yesterday you mentioned **{symptom}** — has it eased today?\n\n",
    journal_yesterday_followup_many: "Yesterday you mentioned a few things ({list}) — how are they today?\n\n",
    journal_streak: "You've journaled {days} of the last 7 days — that's wonderful consistency. ✨\n\n",
    journal_mood_good: "That's wonderful to hear! 😊",
    journal_mood_ok: "Thank you for sharing.",
    journal_mood_low: "I'm here for you. 💚",
    journal_mood_followup: "{ack}\n\nAny physical symptoms today? (e.g., nausea, headache, back pain, or type 'none')",
    journal_mood_invalid: "Please rate your mood from 1 to 10 (1 being very low, 10 being excellent) — or type *stop* to end the check-in.",
    journal_symptoms_noted: "I've noted your symptoms.\n\nHow was your sleep last night? Rate quality (1-10) and hours slept (e.g., \"7/10, 6 hours\")",
    journal_baby_movement_q: "How many times did you feel baby move today? (It's okay if you're not sure yet)",
    journal_water_q: "How many glasses of water did you drink today? (Aim for 8-10 glasses)",
    journal_water_invalid: "Please tell me how many glasses of water (e.g., '6' or '8 glasses')",
    journal_water_great: "Excellent hydration! 💧",
    journal_water_ok: "Good! Try to increase a bit more.",
    journal_water_low: "Try to drink more water tomorrow. It's important for you and baby.",
    journal_water_followup: "{ack}\n\nHow was your appetite today? (good/moderate/poor)",
    journal_appetite_q: "How was your appetite today? (good/moderate/poor)",
    journal_questions_q: "Any questions or concerns you want to discuss with your doctor at your next visit? (or type 'none')",
    journal_notes_q: "Any other notes about your day? How you're feeling overall? (or type 'done' to finish)",
    journal_done: "Today's journal is complete! Type 'journal summary' to see it again or 'weekly summary' for your week's progress.",
    journal_movement_warn: "⚠️ No movement detected. If you haven't felt baby move in the last 12 hours, please contact your healthcare provider immediately.\n\n{water_q}",
    journal_movement_low: "Movement seems low. Try having a cold drink and lying on your left side for an hour to count movements.\n\n{water_q}",
    journal_movement_good: "Good! Regular movement is a great sign. 👶\n\n{water_q}",
    journal_movement_noted: "I've noted that. {water_q}",
    journal_no_active: "No active journal session",
    journal_summary_title: "📊 **Today's Journal Summary**\n\n",
    journal_summary_mood: "**Mood:**",
    journal_summary_symptoms: "**Symptoms:**",
    journal_summary_sleep: "**Sleep:**",
    journal_summary_movement: "**Baby Movement:**",
    journal_summary_water: "**Water:**",
    journal_summary_appetite: "**Appetite:**",
    appetite_good: "good",
    appetite_moderate: "moderate",
    appetite_poor: "poor",
    journal_summary_water_unit: "glasses",
    journal_summary_movement_unit: "times",
    journal_summary_quality: "/10 quality",
    journal_summary_hours: "hours",
    journal_summary_red_flag: "⚠️ **Important:** Some concerning symptoms detected. Please follow up with your healthcare provider.\n\n",
    journal_summary_recs: "**Recommendations:**\n",
    journal_summary_done: "\n✅ Journal saved! Great job taking care of yourself and baby today! 💚",
    journal_no_symptoms: "No symptoms",
    journal_pause: "We'll pause the journal for now. Please seek care first!",
    journal_cancelled: "No problem — I've stopped the check-in. Nothing more will be asked. Type *journal* any time to do one. 💚",
    journal_paused_note: "(I've paused your daily check-in so I can answer you. Type *journal* any time to start it again.)",
    journal_mood_skip: "No problem, we'll skip the mood rating today.",
    journal_water_skip: "No problem, I'll leave water blank today.",
    journal_none_today: "You haven't done a check-in today yet. Type *journal* to start one!",
    help_menu: "Here's what I can do 💚\n\n• Ask me anything about your pregnancy, your baby or how you feel\n• *journal* — a 2-minute daily check-in (type *stop* to end it)\n• *journal summary* / *weekly summary* — see your check-ins\n• *doctor report* — a summary to show your nurse\n• *Kiswahili* or *English* — change language\n• Tell me changes, e.g. \"I'm 28 weeks\", \"my name is …\", \"I gave birth\"\n\n⚠️ Heavy bleeding, a severe headache, fits, or baby not moving: go to the nearest health facility now.",
    help_app_line: "📱 The Amaaii app has your check-ins, charts and profile: {appUrl} — sign in with this WhatsApp number. Our chats show up there too.",
    lang_set_sw: "Sawa! Kuanzia sasa nitakuandikia kwa Kiswahili. 💚 (Ukitaka Kiingereza, andika \"English\".)",
    lang_set_en: "Okay! I'll write to you in English from now on. 💚 (For Kiswahili, just type \"Kiswahili\".)",
    profile_name_updated: "Done — I'll call you {name} from now on. 💚",
    profile_week_updated: "Thanks for telling me — I've changed your pregnancy to week {weeks}. 🤰 I'll count forward from here.",
    delivery_congrats: "Congratulations, mama! 💚 I've noted that your baby has arrived. From now on I'll support you and your newborn — ask me anything about feeding, healing or baby's health.\n\nIf you have heavy bleeding or fever, or the baby isn't feeding, go to the clinic straight away.",
    delivery_ask: "By the way — your due date has passed. Has your baby arrived? If yes, just tell me (for example \"I gave birth on Monday\") so I can support you both. 💚",
    checkin_followup: "Hi! I wanted to check in - were you able to see a healthcare provider? How are you feeling now? 💚",
    ai_error: "I'm sorry, I'm having trouble processing your message right now. Please try again later or contact your healthcare provider if this is urgent. 💚",

    // Heads-up after free-text scan
    heads_up_symptoms: "Thanks for adding that — I noted **{list}**. Worth mentioning at your next visit.\n\n",

    // Reminder + reminder-marker (kept identical so detection works)
    journal_reminder: "💡 Don't forget to do your daily journal! Type 'journal' to start.",

    // Danger sign canned escalations. Direct, command-tone, with concrete
    // numbers — no hedging language ("could be"), because a hedged
    // emergency message reduces compliance.
    danger_critical: "🚨 URGENT — this is a medical emergency. Your safety and your baby's come first.\n\nGO TO HOSPITAL NOW:\n1. The nearest hospital or health centre — leave immediately\n2. Call 999 for an ambulance, or ask anyone to take you\n3. Don't wait, don't drive yourself if you can avoid it\n\nIf this is an emotional crisis, call Befrienders Kenya 0722 178 177.\n\nPlease go now. Tell me when you're safe. 💚",
    danger_high: "⚠️ Important: this symptom needs to be checked by a healthcare provider TODAY.\n\nVisit your nearest clinic or hospital within the next few hours. Don't wait until tomorrow. If it worsens before you can get there, call 999.",
    // Shorter escalation for a repeat mention within the same episode
    // (see escalationVariant in dangerSigns.ts) — the full copy sent three
    // times in a row read as a broken bot in the 2026-10 simulation.
    danger_critical_repeat: "🚨 This still sounds like an emergency. Please go to the nearest hospital now or call 999 — have you been able to get there? If you are already being cared for, tell me and I'll stop repeating this. 💚",
    danger_high_repeat: "⚠️ Please still get this checked by a health worker today. Have you been able to reach a clinic? If you've already been seen, tell me what they said.",
    danger_moderate: "This is worth discussing with your healthcare provider soon. Try to schedule a visit this week.\n\nIn the meantime, rest and monitor how you feel. Tell me right away if symptoms worsen. 💚",

    // Recommendations
    rec_mood_low: "Consider talking to someone about how you're feeling",
    rec_sleep: "Try to get more rest - aim for 7-9 hours",
    rec_water: "Increase water intake to 8-10 glasses daily",
    rec_appetite_poor: "Try small, frequent meals if appetite is low",
    rec_movement: "Monitor baby movements closely today",

    // Voice notes, photos, etc. — the bot can only triage text, so this
    // must still point at a facility for anything urgent.
    unsupported_message_type: "Sorry, I can only read text messages for now — please type your message. 💚\n\n⚠️ If you have heavy bleeding, a severe headache, blurred vision, fits, severe abdominal pain, or your baby has stopped moving, go to the nearest health facility immediately.",

    // Generic error
    error_generic: "I apologize, but I'm having trouble processing your message. Please try again or type 'help' for assistance. If this is urgent, please contact your healthcare provider immediately.",
  },

  sw: {
    // Onboarding
    name_prompt: "Habari! 👋 Mimi ni Amaaii, mwenzio wa ujauzito. Niko hapa kukusaidia katika safari yako ya ujauzito.\n\nJina lako ni nani? Unaweza kuniambia jina lolote unalopenda.",
    name_thanks: "Asante {name}! 💚 Ili nikupe msaada bora, je, una umri gani?",
    age_thanks: "Asante! Mimba yako ina muda gani? 🤰 Unaweza kusema wiki au miezi (mfano \"wiki 20\" au \"miezi 5\"), au tarehe hedhi yako ya mwisho ilipoanza. Kama mtoto ameshazaliwa, niambie lini.",
    age_prompt_again: "Asante {name}! 💚 Ili nikupe msaada bora, je, una umri gani?",
    age_prompt_retry: "Samahani, sikupata umri wako. Una miaka mingapi? Nambari tu inatosha, mfano 24.",
    age_prompt_profile: "Nimefurahi kukujua, {name}! 💚 (Kama ungependa nikuite jina lingine, sema \"niite …\".) Una miaka mingapi?",
    location_prompt_again: "Unaishi mji au eneo gani? (mfano Kibera, Nakuru, Kisumu) Inanisaidia kukuelekeza kliniki ya karibu.",
    postpartum_thanks: "Hongera kwa mtoto wako! 💚 Nitakusaidia katika wiki hizi za mwanzo.\n\nUko wapi? (Hii itanisaidia kukupendekeza vituo vya afya vya karibu inapohitajika)",
    week_thanks: "Vizuri! Una wiki {weeks} za ujauzito. 🤰\n\nUko wapi? (Hii itanisaidia kukupendekeza vituo vya afya vya karibu inapohitajika)",
    week_lmp_thanks: "Kulingana na hedhi yako ya mwisho, una takriban wiki {weeks} za ujauzito. Tarehe ya kujifungua inakadiriwa kuwa karibu na {edd}.\n\nUko wapi? (Hii itanisaidia kukupendekeza vituo vya afya vya karibu)",
    week_prompt_again: "Sikuelewa — hakuna shida! Mojawapo ya haya inafaa:\n• Wiki: \"22\" au \"wiki 22\"\n• Miezi: \"miezi 5\"\n• Hedhi ya mwisho: \"22 Machi\"\n• Hujui? Kadi yako ya kliniki (kitabu cha mama na mtoto) ina tarehe ya kujifungua.\nKama mtoto ameshazaliwa, niambie lini.",
    location_done: "Vizuri! Sasa nina taarifa zako za msingi:\n{summary}\n\nUnaweza:\n• Kushiriki unavyojisikia leo\n• Kuniuliza maswali yoyote ya ujauzito\n• Kuniambia kuhusu dalili zozote unazoona\n• Andika \"help\" kuona ninayoweza kufanya\n\nUnajisikiaje leo? 💚",
    welcome_back: "Karibu tena {name}! Ninawezaje kukusaidia leo?",

    // Consent (P3-B, Kenya DPA) — Kiswahili variants of the EN copy above.
    consent_request: "Kabla hatujaanza, ninahitaji ruhusa yako kuhifadhi na kutumia ujumbe wako ili nikusaidie 💚 Amaaii huhifadhi mazungumzo na taarifa zako za afya kwa usalama, hukupa huduma ya kibinafsi, na hugundua dalili za hatari moja kwa moja — hata kabla hujamaliza kujisajili. Soma taarifa yetu ya faragha: {url}\n\nJibu *NAKUBALI* kuendelea, au *SITAKI* kama hutaki.",
    consent_reprompt: "Sikuelewa vizuri. Ili kutumia Amaaii, tafadhali jibu na neno *NAKUBALI* kukubali taarifa yetu ya faragha na kuendelea — nitakuarifu daima kuhusu dalili za hatari hata hivyo. Soma taarifa hapa: {url}\n\nAu jibu *SITAKI* kama hutaki kuendelea.",
    consent_explain: "Maswali mazuri 💚 Majibu ya moja kwa moja:\n• Mimi ni msaidizi wa kiotomatiki (programu ya kompyuta), si mtu wala nesi.\n• Amaaii ni huduma ya kusaidia wajawazito inayoendeshwa na timu ya Amaaii. Kliniki yako na manesi hawawezi kuona ujumbe wako.\n• Ili nikujibu na kukumbuka tarehe yako ya kujifungua, majarida na maswali yako, ninahitaji kuhifadhi ujumbe wako. Hatuuzi kamwe, na unaweza kuomba tufute kila kitu wakati wowote.\nTaarifa kamili: {url}\n\nUkiwa tayari, tafadhali jibu na neno *NAKUBALI*. Kama hutaki, jibu *SITAKI*.",
    consent_explain_more: "Maelezo zaidi 💚\n• Kinachohifadhiwa: ujumbe wako, tarehe ya kujifungua au wiki, majarida yako, na historia ya afya utakayoniambia.\n• Anayeona: wewe na timu ya Amaaii tu. Kliniki huona rekodi yako tu kama utachagua kuishiriki.\n• Uko na udhibiti: unaweza kuona, kupakua au kufuta kila kitu kwenye programu ya Amaaii (Wasifu → Faragha na data), au uliza tu.\n• Unataka mtu? Nesi aliyekupa namba hii anaweza kujibu maswali kuhusu Amaaii pia.\nTaarifa: {url}\n\nKama ni sawa, tafadhali jibu na neno *NAKUBALI* — au *SITAKI* kama hutaki.",
    consent_declined: "Sawa, hakuna shida — sitakusajili wala kutumia ujumbe wako kukusaidia. 💚 Bado nitakuambia kila wakati ujumbe ukionekana kuwa dalili ya hatari. Ukibadilisha nia, Jibu *NAKUBALI* kuendelea.",
    consent_thanks: "✅ Asante — umekamilisha faragha.\n\n📇 Tafadhali hifadhi namba hii kwenye simu yako kama *Amaaii*, ili ujue kila wakati kwamba ujumbe unatoka kwetu.\n\nSasa hebu tukujue kidogo.",

    web_consent_required: "Unahitaji kukubali idhini ya matumizi ya data ya Amaaii kabla sijazungumza nawe. Tafadhali ikubali kwenye ukurasa wa idhini (pia chini ya Wasifu → Faragha na data) ili kuendelea — bado nitakuarifu kuhusu dalili za hatari unazotaja.",

    ai_off_reply: "Majibu ya AI yamezimwa. Unaweza kuyawasha kwenye programu ya Amaaii chini ya Wasifu → Faragha na data. Bado ninaweza kukusaidia kufuatilia ukaguzi wako na daima nitakuarifu kuhusu dalili za hatari.",

    // Journal
    journal_greeting: "Hebu tufanye ukaguzi wako wa kila siku! 📝\n\nKwanza, unajisikiaje kihisia leo? (Kadiri 1-10, ambapo 1 ni chini sana na 10 ni bora kabisa)",
    journal_continue: "Karibu tena! Hebu tuendelee na ukaguzi wako wa leo 📝\n\nUnajisikiaje kihisia sasa hivi? (1-10)",
    journal_yesterday_followup_one: "Jana ulisema kuhusu **{symptom}** — imepungua leo?\n\n",
    journal_yesterday_followup_many: "Jana ulisema kuhusu mambo machache ({list}) — yakoje leo?\n\n",
    journal_streak: "Umeandika jarida siku {days} kati ya 7 zilizopita — uthabiti mzuri sana. ✨\n\n",
    journal_mood_good: "Hiyo ni habari njema! 😊",
    journal_mood_ok: "Asante kwa kushiriki.",
    journal_mood_low: "Niko hapa kwa ajili yako. 💚",
    journal_mood_followup: "{ack}\n\nUna dalili zozote za kimwili leo? (mfano: kichefuchefu, maumivu ya kichwa, maumivu ya mgongo, au andika 'hapana')",
    journal_mood_invalid: "Tafadhali kadiria hali yako ya akili kutoka 1 hadi 10 (1 ni chini sana, 10 ni bora kabisa) — au andika *acha* kusimamisha jarida.",
    journal_symptoms_noted: "Nimezingatia dalili zako.\n\nUlilala vipi usiku wa jana? Kadiria ubora (1-10) na masaa uliyolala (mfano: \"7/10, masaa 6\")",
    journal_baby_movement_q: "Mtoto alitembea mara ngapi leo? (Ni sawa ikiwa hujui bado)",
    journal_water_q: "Ulikunywa glasi ngapi za maji leo? (Lenga glasi 8-10)",
    journal_water_invalid: "Tafadhali niambie glasi ngapi za maji (mfano: '6' au 'glasi 8')",
    journal_water_great: "Umejitunza vizuri! 💧",
    journal_water_ok: "Vizuri! Jaribu kuongeza kidogo zaidi.",
    journal_water_low: "Jaribu kunywa maji zaidi kesho. Ni muhimu kwako na kwa mtoto.",
    journal_water_followup: "{ack}\n\nHamu yako ya kula ilikuwaje leo? (nzuri/wastani/mbaya)",
    journal_appetite_q: "Hamu yako ya kula ilikuwaje leo? (nzuri/wastani/mbaya)",
    journal_questions_q: "Una maswali au wasiwasi wowote unaotaka kuzungumza na daktari wako kwenye ziara ijayo? (au andika 'hapana')",
    journal_notes_q: "Maelezo mengine yoyote kuhusu siku yako? Unajisikiaje kwa ujumla? (au andika 'maliza' kumaliza)",
    journal_done: "Jarida la leo limekamilika! Andika 'journal summary' kuona tena au 'weekly summary' kwa maendeleo ya wiki yako.",
    journal_movement_warn: "⚠️ Hakuna mwendo umegundulika. Ikiwa hujamhisi mtoto akitembea kwa masaa 12 yaliyopita, tafadhali wasiliana na mtoa huduma wako wa afya mara moja.\n\n{water_q}",
    journal_movement_low: "Mwendo unaonekana ni mdogo. Jaribu kunywa kinywaji baridi na kulala upande wako wa kushoto kwa saa moja kuhesabu mienendo.\n\n{water_q}",
    journal_movement_good: "Vizuri! Mwendo wa kawaida ni ishara nzuri. 👶\n\n{water_q}",
    journal_movement_noted: "Nimezingatia hilo. {water_q}",
    journal_no_active: "Hakuna kikao cha jarida kinachoendelea",
    journal_summary_title: "📊 **Muhtasari wa Jarida la Leo**\n\n",
    journal_summary_mood: "**Hali:**",
    journal_summary_symptoms: "**Dalili:**",
    journal_summary_sleep: "**Usingizi:**",
    journal_summary_movement: "**Mwendo wa Mtoto:**",
    journal_summary_water: "**Maji:**",
    journal_summary_appetite: "**Hamu ya Kula:**",
    appetite_good: "nzuri",
    appetite_moderate: "wastani",
    appetite_poor: "mbaya",
    journal_summary_water_unit: "glasi",
    journal_summary_movement_unit: "mara",
    journal_summary_quality: "/10 ubora",
    journal_summary_hours: "masaa",
    journal_summary_red_flag: "⚠️ **Muhimu:** Baadhi ya dalili zinazoshtua zimegunduliwa. Tafadhali fuatilia na mtoa huduma wako wa afya.\n\n",
    journal_summary_recs: "**Mapendekezo:**\n",
    journal_summary_done: "\n✅ Jarida limehifadhiwa! Hongera kwa kujitunza wewe na mtoto leo! 💚",
    journal_no_symptoms: "Hakuna dalili",
    journal_pause: "Tutasitisha jarida kwa sasa. Tafadhali tafuta huduma kwanza!",
    journal_cancelled: "Sawa — nimesimamisha jarida. Sitakuuliza maswali zaidi. Andika *jarida* wakati wowote kuanza tena. 💚",
    journal_paused_note: "(Nimesimamisha jarida lako la leo ili nikujibu. Andika *jarida* wakati wowote kuanza tena.)",
    journal_mood_skip: "Sawa, tutaruka kipimo cha hisia leo.",
    journal_water_skip: "Sawa, nitaacha maji wazi leo.",
    journal_none_today: "Bado hujafanya jarida la leo. Andika *jarida* kuanza!",
    help_menu: "Haya ndiyo ninayoweza kufanya 💚\n\n• Niulize lolote kuhusu ujauzito wako, mtoto wako au unavyojisikia\n• *jarida* — ukaguzi wa kila siku wa dakika 2 (andika *acha* kusimamisha)\n• *journal summary* / *weekly summary* — ona majarida yako\n• *doctor report* — muhtasari wa kumwonyesha nesi\n• *Kiswahili* au *English* — badilisha lugha\n• Niambie mabadiliko, mfano \"niko wiki 28\", \"jina langu ni …\", \"nimejifungua\"\n\n⚠️ Damu nyingi, maumivu makali ya kichwa, degedege, au mtoto hachezi: nenda kituo cha afya cha karibu sasa hivi.",
    help_app_line: "📱 Programu ya Amaaii ina majarida, chati na wasifu wako: {appUrl} — ingia kwa namba hii ya WhatsApp. Mazungumzo yetu yanaonekana huko pia.",
    lang_set_sw: "Sawa! Kuanzia sasa nitakuandikia kwa Kiswahili. 💚 (Ukitaka Kiingereza, andika \"English\".)",
    lang_set_en: "Okay! I'll write to you in English from now on. 💚 (For Kiswahili, just type \"Kiswahili\".)",
    profile_name_updated: "Sawa — nitakuita {name} kuanzia sasa. 💚",
    profile_week_updated: "Asante kwa kuniambia — nimebadilisha mimba yako kuwa wiki {weeks}. 🤰 Nitahesabu kuanzia hapa.",
    delivery_congrats: "Hongera, mama! 💚 Nimeandika kwamba mtoto wako amezaliwa. Kuanzia sasa nitakusaidia wewe na mtoto — niulize lolote kuhusu kunyonyesha, kupona au afya ya mtoto.\n\nUkiwa na damu nyingi au homa, au mtoto hanyonyi, nenda kliniki mara moja.",
    delivery_ask: "Kwa njia — tarehe yako ya kujifungua imepita. Je, mtoto amezaliwa? Kama ndiyo, niambie tu (mfano \"Nimejifungua Jumatatu\") ili niwasaidie nyote wawili. 💚",
    checkin_followup: "Habari! Nilitaka kukuuliza — uliweza kumwona mhudumu wa afya? Unajisikiaje sasa? 💚",
    ai_error: "Samahani, nina shida kushughulikia ujumbe wako sasa hivi. Tafadhali jaribu tena baadaye, au wasiliana na mhudumu wako wa afya kama ni dharura. 💚",

    heads_up_symptoms: "Asante kwa kuongeza hilo — nimezingatia **{list}**. Inafaa kutaja katika ziara yako ijayo.\n\n",

    journal_reminder: "💡 Usisahau kufanya jarida lako la kila siku! Andika 'journal' kuanza.",

    // Danger sign canned escalations — Kiswahili, command tone, no hedging.
    danger_critical: "🚨 HARAKA SANA — Hii ni dharura. Usalama wako na wa mtoto ni wa kwanza.\n\nNENDA HOSPITALI SASA HIVI:\n1. Kituo cha afya cha karibu zaidi — ondoka mara moja\n2. Piga 999 kwa gari la wagonjwa, au mwombe yeyote akupeleke\n3. Usisubiri. Usijiendeshe gari mwenyewe iwezekanavyo\n\nKama ni shida ya kiakili au unahisi kujidhuru, piga Befrienders Kenya 0722 178 177.\n\nNenda sasa hivi. Niarifu ukifika salama. 💚",
    danger_high: "⚠️ Muhimu: dalili hii inahitaji kuangaliwa na mtoa huduma wa afya LEO.\n\nTembelea kliniki au hospitali ya karibu ndani ya masaa machache. Usisubiri hadi kesho. Ikiwa hali itazidi kabla hujafika, piga 999.",
    danger_critical_repeat: "🚨 Hii bado inaonekana kuwa dharura. Tafadhali nenda hospitali ya karibu sasa au piga 999 — umeweza kufika? Kama tayari unahudumiwa, niambie na nitaacha kurudia ujumbe huu. 💚",
    danger_high_repeat: "⚠️ Tafadhali bado uangaliwe na mhudumu wa afya leo. Umeweza kufika kliniki? Kama tayari umeonwa, niambie walisema nini.",
    danger_moderate: "Hii inafaa kuzungumza na mtoa huduma wako wa afya hivi karibuni. Jaribu kupanga ziara wiki hii.\n\nWakati huo, pumzika na ufuatilie unavyojisikia. Niambie mara moja ikiwa dalili zinaongezeka. 💚",

    // Recommendations
    rec_mood_low: "Fikiria kuzungumza na mtu kuhusu unavyojisikia",
    rec_sleep: "Jaribu kupumzika zaidi - lenga masaa 7-9",
    rec_water: "Ongeza unywaji wa maji hadi glasi 8-10 kila siku",
    rec_appetite_poor: "Jaribu chakula kidogo, mara nyingi ikiwa hamu ni ndogo",
    rec_movement: "Fuatilia mwendo wa mtoto kwa makini leo",

    unsupported_message_type: "Samahani, kwa sasa ninaweza kusoma ujumbe wa maandishi tu — tafadhali andika ujumbe wako. 💚\n\n⚠️ Ikiwa unatokwa na damu nyingi, una maumivu makali ya kichwa, unaona ukungu, una degedege, maumivu makali ya tumbo, au mtoto ameacha kucheza tumboni, nenda kwenye kituo cha afya kilicho karibu mara moja.",

    error_generic: "Samahani, nina shida kuchakata ujumbe wako. Tafadhali jaribu tena au andika 'help' kwa msaada. Ikiwa ni ya dharura, tafadhali wasiliana na mtoa huduma wako wa afya mara moja.",
  },
};

export function pickLang(lang?: string | null): Lang {
  if (lang === 'sw' || lang === 'kiswahili' || lang === 'sw-KE') return 'sw';
  return 'en';
}

// t(lang, key, vars?) → string. Falls back to EN if a key is missing
// in the requested language (so half-translated keys never break the UI).
// `key` is intentionally a loose string, not a union — some callers
// build it dynamically (e.g. `appetite_${data.appetite}`).
export function t(lang: string | null | undefined, key: string, vars?: Record<string, string | number>): string {
  const L = pickLang(lang);
  const dict = STRINGS[L] || STRINGS.en;
  let s = dict[key];
  if (s === undefined) s = STRINGS.en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

// Display label used in profile UI / logs.
export function label(lang?: string | null): string {
  return pickLang(lang) === 'sw' ? 'Kiswahili' : 'English';
}

// Canned danger-sign escalation copy for a given urgency + language.
// Shared by messageHandler.js (top-level routing) and journalManager.js
// (mid-journal free-text scanning) — identical logic lived in both
// files before this migration; unified here since both just call t().
export function dangerCopy(level: Urgency | string | undefined, lang?: string | null): string {
  if (level === 'critical') return t(lang, 'danger_critical');
  if (level === 'high') return t(lang, 'danger_high');
  if (level === 'moderate') return t(lang, 'danger_moderate');
  return '';
}

// The short "still an emergency — have you reached care?" form, for a
// repeat escalation inside the same episode (see escalationVariant).
export function dangerRepeatCopy(level: Urgency | string | undefined, lang?: string | null): string {
  if (level === 'critical') return t(lang, 'danger_critical_repeat');
  if (level === 'high') return t(lang, 'danger_high_repeat');
  return dangerCopy(level, lang);
}

// ---------------------------------------------------------------------------
// Language detection for a NEW WhatsApp user (consent + onboarding only —
// afterwards the language changes only on an explicit request, so a mother
// who code-switches doesn't flip back and forth). In the simulation every
// WhatsApp mother ended up on 'en', including the ones who only wrote
// Kiswahili. Returns null when the message is too short or too mixed.
// ---------------------------------------------------------------------------
const SW_MARKERS = new Set([
  'na', 'ni', 'ya', 'wa', 'za', 'la', 'kwa', 'sana', 'nina', 'niko', 'mimi', 'wewe', 'habari', 'asante',
  'tafadhali', 'nini', 'gani', 'leo', 'jana', 'kesho', 'mtoto', 'mimba', 'sijui', 'sawa', 'hapana', 'ndiyo',
  'ndio', 'naomba', 'nataka', 'kuna', 'hii', 'hiyo', 'lakini', 'pia', 'bado', 'kidogo', 'wiki', 'miezi',
  'mwezi', 'damu', 'homa', 'maumivu', 'kichwa', 'tumbo', 'daktari', 'kliniki', 'hospitali', 'vizuri',
  'mzuri', 'salama', 'karibu', 'shida', 'msaada', 'kwanini', 'vipi', 'sasa', 'mama', 'kama', 'hapa',
  'huku', 'yangu', 'wangu', 'changu', 'langu', 'yako', 'wako', 'nimechoka', 'naogopa', 'nifanye',
  'mpaka', 'tu', 'jina', 'miaka', 'umri', 'nakubali', 'jambo', 'hujambo', 'sijambo', 'shikamoo',
]);
const SW_VERB = /^(?:nina|nili|nime|nita|nisi|tuna|tume|tuli|wame|wali|wana|una|ume|uli)[a-z]{3,}$/;

export function detectLanguage(message: string): Lang | null {
  // Place names are not language: "Homa Bay" is a county, not "homa".
  const words = (message || '').toLowerCase().replace(/\bhoma\s*bay\b/g, ' ').match(/[a-z']+/g) || [];
  // A town name or a one-word answer says nothing about her language.
  if (words.length < 3) return null;
  const sw = words.filter((w) => SW_MARKERS.has(w) || SW_VERB.test(w)).length;
  const ratio = sw / words.length;
  if (ratio >= 0.35 && sw >= 2) return 'sw';
  if (ratio <= 0.1) return 'en';
  return null;
}
