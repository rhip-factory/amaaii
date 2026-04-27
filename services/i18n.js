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

const STRINGS = {
  en: {
    // Onboarding
    name_prompt: "Hello! 👋 I'm Amaaii, your pregnancy companion. I'm here to support you throughout your pregnancy journey.\n\nWhat's your name? You can call me by any name you're comfortable with.",
    name_thanks: "Thank you {name}! 💚 To provide you with the best support, could you tell me your age?",
    age_thanks: "Thank you! How many weeks pregnant are you? (If you're not sure, you can tell me the date of your last period)",
    age_prompt_again: "Thank you {name}! 💚 To provide you with the best support, could you tell me your age?",
    week_thanks: "Great! You're {weeks} weeks along. 🤰\n\nWhere are you located? (This helps me suggest nearby health facilities when needed)",
    week_lmp_thanks: "Based on your last period, you're about {weeks} weeks pregnant. Your expected delivery date is around {edd}.\n\nWhere are you located? (This helps me suggest nearby health facilities when needed)",
    week_prompt_again: "How many weeks pregnant are you? You can also tell me the date of your last menstrual period (LMP) if you remember it.",
    location_done: "Perfect! I now have your basic information:\n{summary}\n\nYou can:\n• Share how you're feeling today\n• Ask me any pregnancy questions\n• Tell me about any symptoms you're experiencing\n• Type \"help\" to see what I can do\n\nHow are you feeling today? 💚",
    welcome_back: "Welcome back {name}! How can I help you today?",

    // Journal
    journal_greeting: "Let's do your daily check-in! 📝\n\nFirst, how are you feeling emotionally today? (Rate 1-10, where 1 is very low and 10 is excellent)",
    journal_continue: "Welcome back! Let's continue your daily check-in 📝\n\nHow are you feeling emotionally right now? (1-10)",
    journal_mood_good: "That's wonderful to hear! 😊",
    journal_mood_ok: "Thank you for sharing.",
    journal_mood_low: "I'm here for you. 💚",
    journal_mood_followup: "{ack}\n\nAny physical symptoms today? (e.g., nausea, headache, back pain, or type 'none')",
    journal_mood_invalid: "Please rate your mood from 1 to 10 (1 being very low, 10 being excellent)",
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
    journal_summary_water_unit: "glasses",
    journal_summary_movement_unit: "times",
    journal_summary_quality: "/10 quality",
    journal_summary_hours: "hours",
    journal_summary_red_flag: "⚠️ **Important:** Some concerning symptoms detected. Please follow up with your healthcare provider.\n\n",
    journal_summary_recs: "**Recommendations:**\n",
    journal_summary_done: "\n✅ Journal saved! Great job taking care of yourself and baby today! 💚",
    journal_no_symptoms: "No symptoms",
    journal_pause: "We'll pause the journal for now. Please seek care first!",

    // Heads-up after free-text scan
    heads_up_symptoms: "Thanks for adding that — I noted **{list}**. Worth mentioning at your next visit.\n\n",

    // Reminder + reminder-marker (kept identical so detection works)
    journal_reminder: "💡 Don't forget to do your daily journal! Type 'journal' to start.",

    // Danger sign canned escalations
    danger_critical: "⚠️ URGENT: What you're describing could be very serious and needs IMMEDIATE medical attention.\n\nPlease do one of these RIGHT NOW:\n1. Go to the nearest hospital/health center\n2. Call an ambulance if available\n3. Ask someone to take you\n\nThis cannot wait. Please go now and let me know once you're there. 💚",
    danger_high: "⚠️ Important: This symptom needs to be checked by a healthcare provider TODAY.\n\nPlease visit your nearest clinic or hospital within the next few hours. Would you like help finding the closest facility?",
    danger_moderate: "This is something to discuss with your healthcare provider soon. Can you schedule a visit this week?\n\nIn the meantime, rest and monitor how you feel. Let me know if symptoms worsen. 💚",

    // Recommendations
    rec_mood_low: "Consider talking to someone about how you're feeling",
    rec_sleep: "Try to get more rest - aim for 7-9 hours",
    rec_water: "Increase water intake to 8-10 glasses daily",
    rec_appetite_poor: "Try small, frequent meals if appetite is low",
    rec_movement: "Monitor baby movements closely today",

    // Generic error
    error_generic: "I apologize, but I'm having trouble processing your message. Please try again or type 'help' for assistance. If this is urgent, please contact your healthcare provider immediately.",
  },

  sw: {
    // Onboarding
    name_prompt: "Habari! 👋 Mimi ni Amaaii, mwenzio wa ujauzito. Niko hapa kukusaidia katika safari yako ya ujauzito.\n\nJina lako ni nani? Unaweza kuniambia jina lolote unalopenda.",
    name_thanks: "Asante {name}! 💚 Ili nikupe msaada bora, je, una umri gani?",
    age_thanks: "Asante! Una wiki ngapi za ujauzito? (Ikiwa hujui, unaweza kuniambia tarehe ya hedhi yako ya mwisho)",
    age_prompt_again: "Asante {name}! 💚 Ili nikupe msaada bora, je, una umri gani?",
    week_thanks: "Vizuri! Una wiki {weeks} za ujauzito. 🤰\n\nUko wapi? (Hii itanisaidia kukupendekeza vituo vya afya vya karibu inapohitajika)",
    week_lmp_thanks: "Kulingana na hedhi yako ya mwisho, una takriban wiki {weeks} za ujauzito. Tarehe ya kujifungua inakadiriwa kuwa karibu na {edd}.\n\nUko wapi? (Hii itanisaidia kukupendekeza vituo vya afya vya karibu)",
    week_prompt_again: "Una wiki ngapi za ujauzito? Au unaweza kuniambia tarehe ya hedhi yako ya mwisho ikiwa unakumbuka.",
    location_done: "Vizuri! Sasa nina taarifa zako za msingi:\n{summary}\n\nUnaweza:\n• Kushiriki unavyojisikia leo\n• Kuniuliza maswali yoyote ya ujauzito\n• Kuniambia kuhusu dalili zozote unazoona\n• Andika \"help\" kuona ninayoweza kufanya\n\nUnajisikiaje leo? 💚",
    welcome_back: "Karibu tena {name}! Ninawezaje kukusaidia leo?",

    // Journal
    journal_greeting: "Hebu tufanye ukaguzi wako wa kila siku! 📝\n\nKwanza, unajisikiaje kihisia leo? (Kadiri 1-10, ambapo 1 ni chini sana na 10 ni bora kabisa)",
    journal_continue: "Karibu tena! Hebu tuendelee na ukaguzi wako wa leo 📝\n\nUnajisikiaje kihisia sasa hivi? (1-10)",
    journal_mood_good: "Hiyo ni habari njema! 😊",
    journal_mood_ok: "Asante kwa kushiriki.",
    journal_mood_low: "Niko hapa kwa ajili yako. 💚",
    journal_mood_followup: "{ack}\n\nUna dalili zozote za kimwili leo? (mfano: kichefuchefu, maumivu ya kichwa, maumivu ya mgongo, au andika 'hapana')",
    journal_mood_invalid: "Tafadhali kadiria hali yako ya akili kutoka 1 hadi 10 (1 ni chini sana, 10 ni bora kabisa)",
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
    journal_summary_water_unit: "glasi",
    journal_summary_movement_unit: "mara",
    journal_summary_quality: "/10 ubora",
    journal_summary_hours: "masaa",
    journal_summary_red_flag: "⚠️ **Muhimu:** Baadhi ya dalili zinazoshtua zimegunduliwa. Tafadhali fuatilia na mtoa huduma wako wa afya.\n\n",
    journal_summary_recs: "**Mapendekezo:**\n",
    journal_summary_done: "\n✅ Jarida limehifadhiwa! Hongera kwa kujitunza wewe na mtoto leo! 💚",
    journal_no_symptoms: "Hakuna dalili",
    journal_pause: "Tutasitisha jarida kwa sasa. Tafadhali tafuta huduma kwanza!",

    heads_up_symptoms: "Asante kwa kuongeza hilo — nimezingatia **{list}**. Inafaa kutaja katika ziara yako ijayo.\n\n",

    journal_reminder: "💡 Usisahau kufanya jarida lako la kila siku! Andika 'journal' kuanza.",

    // Danger sign canned escalations
    danger_critical: "⚠️ HARAKA: Unayoyaelezea yanaweza kuwa makubwa sana na yanahitaji matibabu MARA MOJA.\n\nTafadhali fanya mojawapo ya haya SASA HIVI:\n1. Nenda hospitali/kituo cha afya cha karibu\n2. Piga simu kwa gari la wagonjwa ikiwa inapatikana\n3. Mwombe mtu akupeleke\n\nHili haliwezi kungoja. Tafadhali nenda sasa na uniarifu ukifika. 💚",
    danger_high: "⚠️ Muhimu: Dalili hii inahitaji kuangaliwa na mtoa huduma wa afya LEO.\n\nTafadhali tembelea kliniki au hospitali ya karibu ndani ya masaa machache. Ungependa msaada kupata kituo cha karibu?",
    danger_moderate: "Hili ni jambo la kuzungumza na mtoa huduma wako wa afya hivi karibuni. Unaweza kupanga ziara wiki hii?\n\nWakati huo, pumzika na ufuatilie unavyojisikia. Niarifu ikiwa dalili zinaongezeka. 💚",

    // Recommendations
    rec_mood_low: "Fikiria kuzungumza na mtu kuhusu unavyojisikia",
    rec_sleep: "Jaribu kupumzika zaidi - lenga masaa 7-9",
    rec_water: "Ongeza unywaji wa maji hadi glasi 8-10 kila siku",
    rec_appetite_poor: "Jaribu chakula kidogo, mara nyingi ikiwa hamu ni ndogo",
    rec_movement: "Fuatilia mwendo wa mtoto kwa makini leo",

    error_generic: "Samahani, nina shida kuchakata ujumbe wako. Tafadhali jaribu tena au andika 'help' kwa msaada. Ikiwa ni ya dharura, tafadhali wasiliana na mtoa huduma wako wa afya mara moja.",
  },
};

function pickLang(lang) {
  if (lang === 'sw' || lang === 'kiswahili' || lang === 'sw-KE') return 'sw';
  return 'en';
}

// t(lang, key, vars?) → string. Falls back to EN if a key is missing
// in the requested language (so half-translated keys never break the UI).
function t(lang, key, vars) {
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
function label(lang) {
  return pickLang(lang) === 'sw' ? 'Kiswahili' : 'English';
}

module.exports = { t, label, pickLang };
