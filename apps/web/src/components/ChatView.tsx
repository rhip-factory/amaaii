"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./ChatView.module.css";
import { SendIcon } from "./icons";
import { ApiError, fetchConversations, sendChatMessage } from "@/lib/api";
import type { ChatMessage, ConversationTurn } from "@/lib/types";
import { whatsappLink } from "@/lib/whatsapp";

const SUGGESTIONS = [
  { label: "Say hi", msg: "Hi" },
  { label: "Daily journal", msg: "journal" },
  { label: "I'm feeling anxious", msg: "I have been feeling a bit anxious" },
];

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// GET /conversations rows -> bubbles. SQLite timestamps are UTC without a zone.
function turnsToMessages(turns: ConversationTurn[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of turns) {
    const timestamp = `${t.at.replace(" ", "T")}Z`;
    if (t.message) out.push({ id: `h${t.id}u`, role: "user", text: t.message, timestamp, channel: t.channel });
    if (t.response) {
      out.push({
        id: `h${t.id}b`,
        role: "bot",
        text: t.response,
        urgency: t.urgencyLevel ?? undefined,
        timestamp,
        channel: t.channel,
      });
    }
  }
  return out;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

interface ChatViewProps {
  initialPrefill?: string;
}

export default function ChatView({ initialPrefill }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(initialPrefill ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // One conversation across WhatsApp and the app: load what came before.
  useEffect(() => {
    let cancelled = false;
    fetchConversations(50)
      .then(({ turns }) => {
        if (cancelled) return;
        setMessages((prev) => [...turnsToMessages(turns), ...prev]);
      })
      .catch(() => {
        /* offline or signed out: start with an empty chat, as before */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setError(null);
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: makeId(), role: "user", text: trimmed, timestamp: new Date().toISOString() },
    ]);
    setSending(true);
    try {
      const result = await sendChatMessage(trimmed);
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: "bot",
          text: result.response,
          urgency: result.urgencyLevel,
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // authedFetch already redirected to /login
        return;
      }
      setError("Connection trouble — please try again in a moment.");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(input);
  }

  return (
    <div className={styles.stage}>
      <div className={styles.messages} ref={scrollRef} aria-live="polite">
        {messages.length === 0 && (
          <div className={styles.welcome}>
            <h2>Hi, I&apos;m Amaaii.</h2>
            <p>Your pregnancy companion. I&apos;m here to listen, journal your day, and flag anything that needs urgent care.</p>
            <div className={styles.suggestions}>
              {SUGGESTIONS.map((s) => (
                <button key={s.msg} type="button" className={styles.suggest} onClick={() => send(s.msg)}>
                  {s.label}
                </button>
              ))}
              {whatsappLink("Hi Amaaii") && (
                <a className={styles.suggest} href={whatsappLink("Hi Amaaii")!} target="_blank" rel="noopener noreferrer">
                  Chat on WhatsApp instead
                </a>
              )}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`${styles.bubbleRow} ${styles[m.role]}`}>
            <div
              className={`${styles.bubble} ${m.urgency === "critical" ? styles.critical : ""} ${
                m.urgency === "high" ? styles.high : ""
              }`}
            >
              {m.text}
            </div>
            <span className={styles.timestamp}>
              {formatTime(m.timestamp)}
              {m.channel === "whatsapp" ? " · on WhatsApp" : ""}
            </span>
          </div>
        ))}

        {sending && (
          <div className={styles.typingBubble} aria-label="Amaaii is typing">
            <span />
            <span />
            <span />
          </div>
        )}

        {error && <p className={styles.errorNote}>{error}</p>}
      </div>

      <form className={styles.composer} onSubmit={onSubmit}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Type a message…"
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="send"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className={styles.sendBtn} disabled={sending || !input.trim()} aria-label="Send">
          <SendIcon width={20} height={20} />
        </button>
      </form>
    </div>
  );
}
