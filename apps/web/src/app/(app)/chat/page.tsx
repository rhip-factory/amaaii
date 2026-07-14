"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import ChatView from "@/components/ChatView";

function ChatPageInner() {
  const params = useSearchParams();
  const prefill = params.get("prefill") === "journal" ? "journal" : undefined;
  return (
    <div style={{ height: "100%" }}>
      <ChatView initialPrefill={prefill} />
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div style={{ height: "100%" }} />}>
      <ChatPageInner />
    </Suspense>
  );
}
