// Reply buttons for the canned messages that ask her to send a word
// ("tap *None*", "tap *I AGREE*", "tap *Start journal*"). Mothers who
// don't type easily get a WhatsApp reply button (a chip in the app)
// instead of having to spell the word back.
//
// A button's title is the word the copy asks for, and a tap arrives as
// that title's text, so it routes exactly as if she had typed it:
// tests/actionButtons.test.ts drives every label through processMessage.
//
// The buttons are found from the finished reply text, the same way the
// onboarding and consent gates recognise their own prompts: each entry
// below is a fixed phrase of one canned string. That keeps the buttons
// right when canned copy is appended to an AI reply (the journal
// reminder). Pure, no I/O.

import { t } from './i18n';
import type { Lang } from './types';

export type ActionId =
  | 'agree'
  | 'start_journal'
  | 'help'
  | 'none'
  | 'done'
  | 'stop'
  | 'appetite_good'
  | 'appetite_moderate'
  | 'appetite_poor'
  | 'journal_summary'
  | 'weekly_summary'
  | 'doctor_report'
  | 'lang_sw'
  | 'lang_en';

/** WhatsApp allows at most 3 reply buttons on one message. */
export const MAX_ACTION_BUTTONS = 3;

interface ActionPrompt {
  /** Lower-case phrase of the canned copy (i18n.ts) that asks for it. */
  marker: string;
  lang: Lang;
  actions: ActionId[];
}

export const ACTION_PROMPTS: ActionPrompt[] = [
  { marker: '*i agree*', lang: 'en', actions: ['agree'] },
  { marker: '*nakubali*', lang: 'sw', actions: ['agree'] },
  { marker: "here's what i can do", lang: 'en', actions: ['start_journal', 'weekly_summary', 'doctor_report'] },
  { marker: 'haya ndiyo ninayoweza kufanya', lang: 'sw', actions: ['start_journal', 'weekly_summary', 'doctor_report'] },
  // Any bold mention: the AI writes "tapping *Start journal*" or
  // "bonyeza kitufe cha *Anza jarida*" as often as the canned phrase.
  { marker: '*start journal*', lang: 'en', actions: ['start_journal'] },
  { marker: '*anza jarida*', lang: 'sw', actions: ['start_journal'] },
  { marker: 'tap *help*', lang: 'en', actions: ['help'] },
  { marker: 'bonyeza *msaada*', lang: 'sw', actions: ['help'] },
  { marker: 'tap *none*', lang: 'en', actions: ['none'] },
  { marker: 'bonyeza *hapana*', lang: 'sw', actions: ['none'] },
  { marker: 'tap *done*', lang: 'en', actions: ['done'] },
  { marker: 'bonyeza *maliza*', lang: 'sw', actions: ['done'] },
  { marker: 'tap *stop check-in*', lang: 'en', actions: ['stop'] },
  { marker: 'bonyeza *acha jarida*', lang: 'sw', actions: ['stop'] },
  { marker: 'tap *good*, *moderate* or *poor*', lang: 'en', actions: ['appetite_good', 'appetite_moderate', 'appetite_poor'] },
  { marker: 'bonyeza *nzuri*, *wastani* au *mbaya*', lang: 'sw', actions: ['appetite_good', 'appetite_moderate', 'appetite_poor'] },
  { marker: 'tap *journal summary*', lang: 'en', actions: ['journal_summary', 'weekly_summary'] },
  { marker: 'bonyeza *muhtasari wa leo*', lang: 'sw', actions: ['journal_summary', 'weekly_summary'] },
  { marker: 'tap *kiswahili*', lang: 'en', actions: ['lang_sw'] },
  { marker: 'bonyeza *english*', lang: 'sw', actions: ['lang_en'] },
];

export interface ActionButtons {
  options: string[];
  /** The language of the prompt the buttons came from. */
  lang: Lang;
}

function promptHits(text: string): { p: ActionPrompt; at: number }[] {
  // The AI reply may bold with **…** where the canned copy uses *…*.
  const lower = text.toLowerCase().replace(/\*\*/g, '*');
  return ACTION_PROMPTS
    .map((p) => ({ p, at: lower.indexOf(p.marker) }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at);
}

/** Whether `text` (e.g. Amaaii's last message) invited her to start a check-in. */
export function offersJournal(text: string): boolean {
  return promptHits(text).some(({ p }) => p.actions.includes('start_journal'));
}

/** The reply buttons a finished reply should carry, in the order its
 *  prompts appear (max 3), or null when it asks for nothing. */
export function actionButtonsFor(text: string): ActionButtons | null {
  const hits = promptHits(text);
  if (!hits.length) return null;
  const options: string[] = [];
  for (const { p } of hits) {
    for (const id of p.actions) {
      const label = t(p.lang, `btn_${id}`);
      if (!options.includes(label)) options.push(label);
    }
  }
  return { options: options.slice(0, MAX_ACTION_BUTTONS), lang: hits[0].p.lang };
}

/** The text form, for a transport without buttons (or a failed button
 *  send): the reply plus the words she can send back. */
export function withButtonHint(body: string, buttons: ActionButtons): string {
  const options = buttons.options.map((o) => `*${o}*`).join(' / ');
  return `${body}\n\n${t(buttons.lang, 'buttons_text_hint', { options })}`;
}
