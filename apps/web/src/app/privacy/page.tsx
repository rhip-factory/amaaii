import Image from "next/image";
import Link from "next/link";
import styles from "./privacy.module.css";

export const metadata = { title: "Privacy notice — Amaaii" };

// P3-D: the privacy notice WhatsApp's consent prompt links to
// (messageHandler.ts's privacyNoticeUrl() -> "{PUBLIC_BASE_URL}/privacy")
// and the consent gate / Profile screen link to on the PWA side. Public
// and unauthenticated on purpose — a WhatsApp user may tap this link
// before ever logging into the PWA, straight from the consent_request /
// consent_reprompt message. Server component (no "use client"): pure
// static content, no fetches, nothing personalized — safe to prerender
// into the static export exactly like /offline.
//
// LEGAL-REVIEW FLAG (kept out of the visible page, emitted as a real
// HTML comment below via dangerouslySetInnerHTML — visible in "view
// source" / the exported HTML, not in the rendered page): this copy was
// written by engineering for P3-D functional coverage of the Kenya Data
// Protection Act's notice requirements. It has NOT been reviewed by
// counsel. Flagged for P3-E before this is relied on as the actual,
// binding privacy notice.
const LEGAL_REVIEW_COMMENT =
  "<!-- LEGAL REVIEW NEEDED (P3-E): this privacy notice was drafted by " +
  "engineering for P3-D functional coverage of the Kenya Data Protection " +
  "Act's notice requirements. It has not been reviewed by counsel. Do " +
  "not treat as final/binding legal copy until that review happens. -->";

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <div
        aria-hidden="true"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: LEGAL_REVIEW_COMMENT }}
      />

      <div className={styles.wrap}>
        <header className={styles.header}>
          <Link href="/" className={styles.brandLink}>
            <Image src="/img/logo-lockup-purple.png" alt="Amaaii" width={128} height={42} priority />
          </Link>
          <Link href="/" className={styles.backLink}>
            ← Back to Amaaii
          </Link>
        </header>

        <h1 className={styles.title}>Privacy notice</h1>
        <p className={styles.updated}>Applies from consent version 1.</p>

        <p className={styles.intro}>
          Amaaii is built by RHIP Factory to support pregnant and postpartum mothers in Kenya, on
          WhatsApp and on this app. This notice explains, in plain language, what we collect, why, who
          else sees it, and the rights you have over it under Kenya&rsquo;s Data Protection Act, 2019.
        </p>

        <section className={styles.section}>
          <h2 className={styles.h2}>What we collect</h2>
          <ul className={styles.list}>
            <li>
              <strong>Your profile:</strong> phone number, name, age, pregnancy week or last period date,
              location, and preferred language.
            </li>
            <li>
              <strong>Journal check-ins:</strong> mood, sleep, appetite, physical symptoms, baby movement
              counts (from week 20), and any notes you add.
            </li>
            <li>
              <strong>Conversations:</strong> messages you send Amaaii on WhatsApp or in the app&rsquo;s
              Chat tab, and the replies you get back.
            </li>
            <li>
              <strong>Medical history</strong> you choose to share with us (e.g. past conditions, prior
              pregnancies) — this is entirely optional.
            </li>
            <li>
              <strong>Danger-sign detections:</strong> when something you say matches an urgent symptom
              pattern (heavy bleeding, severe headache, and similar), so we can escalate appropriately.
            </li>
            <li>
              <strong>Consent and access records:</strong> what you&rsquo;ve agreed to, when, and a log of
              when your data was read, written, or exported — the same log you can see in{" "}
              <Link href="/">the app&rsquo;s Profile screen</Link>.
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Why we process it</h2>
          <p className={styles.body}>We ask for your permission for two separate things:</p>
          <ul className={styles.list}>
            <li>
              <strong>Storing your health information (required).</strong> This is what makes Amaaii work
              at all — without it, there&rsquo;s nothing to journal against, remember, or watch for danger
              signs in.
            </li>
            <li>
              <strong>Using AI to personalise replies (optional).</strong> If you agree, what you type may
              be sent to our AI provider to write a reply tailored to you. If you decline or later turn
              this off, you keep everything else: journaling, trends, and urgent-symptom alerts all keep
              working — you&rsquo;ll get simpler, non-AI guidance instead of an AI-written reply.
            </li>
          </ul>
          <p className={styles.body}>
            One exception applies regardless of either choice: if what you say matches an urgent danger
            sign, we always act on it and tell you to seek care. That check is a fixed set of local rules,
            not the AI, and it never depends on your consent status — we treat this as a vital-interests
            safety measure, not a marketing or convenience feature.
          </p>
        </section>

        <section className={`${styles.section} ${styles.crossBorder}`}>
          <h2 className={styles.h2}>Who processes your data — including outside Kenya</h2>
          <p className={styles.body}>
            We use two outside providers to run Amaaii, and both process data on servers{" "}
            <strong>outside Kenya, in the United States:</strong>
          </p>
          <ul className={styles.list}>
            <li>
              <strong>OpenAI</strong> — powers the optional AI replies described above. Before anything
              reaches OpenAI, we strip out identifying details like your phone number, email, and full
              name from your message text; only your first name (if you&rsquo;ve shared one) may appear,
              so a reply can still feel personal.
            </li>
            <li>
              <strong>Twilio</strong> — delivers and receives your WhatsApp messages, and sends the
              one-time codes you use to sign in.
            </li>
          </ul>
          <p className={styles.body}>
            We only share what each provider needs to do its specific job — never your full profile or
            journal history. We don&rsquo;t sell your data, and we don&rsquo;t share it with advertisers.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>How long we keep it</h2>
          <p className={styles.body}>
            We keep your data for as long as your account is active, so Amaaii can keep recognising
            patterns over the course of your pregnancy and beyond. We don&rsquo;t currently run an
            automatic deletion schedule for inactive accounts. You can request deletion at any time — see
            your rights below — and it takes effect immediately and permanently.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Your rights</h2>
          <ul className={styles.list}>
            <li>
              <strong>Access &amp; export.</strong> Download everything we hold about you as a single file
              from Profile → Export my data (or the API directly, if you prefer).
            </li>
            <li>
              <strong>Rectification.</strong> Correct your profile any time in Profile → Your profile.
              For a correction to a past journal entry or conversation, contact us (below).
            </li>
            <li>
              <strong>Withdraw consent.</strong> Turn AI replies off any time in Profile → Privacy &amp;
              data. Withdrawing the required data-processing consent means we stop processing your data
              going forward, but it doesn&rsquo;t erase what&rsquo;s already stored — for that, use
              deletion.
            </li>
            <li>
              <strong>Deletion / erasure.</strong> Permanently delete your account and everything in it
              from Profile → Delete my account. This cannot be undone.
            </li>
            <li>
              <strong>Complain to the regulator.</strong> If you&rsquo;re unhappy with how we&rsquo;ve
              handled your data, you can lodge a complaint with Kenya&rsquo;s Office of the Data
              Protection Commissioner (ODPC).
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2 className={styles.h2}>Contact us</h2>
          <p className={styles.body}>
            Questions about this notice or your data — message the same WhatsApp number you use with
            Amaaii, or email <a href="mailto:privacy@amaaii.app">privacy@amaaii.app</a>.
          </p>
        </section>

        <section className={styles.swSummary}>
          <h2 className={styles.h2}>Kwa Kifupi (Kiswahili)</h2>
          <p className={styles.body}>
            Amaaii huhifadhi taarifa zako za afya ili kukusaidia — hii ni lazima ili programu ifanye kazi.
            Matumizi ya AI kwa majibu ya kibinafsi ni hiari; ukikataa, bado utapata ukaguzi wa kila siku na
            arifa za dharura. Taarifa zako zinaweza kuchakatwa na washirika wetu (OpenAI, Twilio) nje ya
            Kenya, Marekani. Unaweza kupakua, kubadilisha idhini yako, au kufuta akaunti yako wakati wowote
            kupitia Profaili.
          </p>
        </section>

        <p className={styles.footNote}>
          This notice may change if we change how Amaaii works — we&rsquo;ll ask you to review and
          reconfirm your consent whenever it does.
        </p>
      </div>
    </main>
  );
}
