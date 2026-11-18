"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../context";
import { ASSISTANT_NAME } from "../lab/FalconMark";
import { LabChat } from "../lab/LabChat";
import { clearPendingAsk, usePendingAsk } from "../lab/app-bridge";
import { MemoryButton } from "../lab/MemoryView";
import { SessionGrid } from "../lab/SessionGrid";
import { LAB_NEW_LABEL, newId, useLabSessions } from "../lab/sessions";
import { CardHeader } from "../shell/ui";

/**
 * Desk: a grid with the New card and this workspace's Falcon AI sessions
 * (lab/SessionGrid.tsx: search, pin, rename, delete, drag to reorder); a card
 * opens its chat (lab/LabChat.tsx). Sessions live in sessionStorage for now
 * (lab/sessions.ts).
 */
export function StrategyTab({ headerExtra }: { headerExtra?: React.ReactNode }) {
  const { userId } = useWorkspace();
  const { sessions, send, stop, answer, retry, edit, vote, rename, pin, moveTo, remove } = useLabSessions(userId);
  const [openId, setOpenId] = useState<string | null>(null);
  const backTo = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // "Ask Falcon AI" on a ticker, sighting or graph company: a new session with the prompt in the composer.
  const asked = usePendingAsk();
  const [prefill, setPrefill] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    if (!asked) return;
    const id = newId();
    setPrefill({ id, text: asked });
    setOpenId(id);
    clearPendingAsk();
  }, [asked]);

  // Back from a chat: put focus on that session's card (or the New card).
  useEffect(() => {
    if (openId !== null || backTo.current === null) return;
    const id = backTo.current;
    backTo.current = null;
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-lab-card="${CSS.escape(id)}"]`) ?? gridRef.current?.querySelector<HTMLButtonElement>('[data-lab-card="new"]');
    el?.focus();
  }, [openId]);

  if (openId !== null) {
    const session = sessions.find((s) => s.id === openId);
    return (
      <LabChat
        key={openId}
        session={session}
        title={session?.title ?? LAB_NEW_LABEL}
        headerExtra={<><MemoryButton scope={userId} />{headerExtra}</>}
        initialText={prefill?.id === openId ? prefill.text : undefined}
        onSend={(text, images) => send(openId, text, images)}
        onStop={() => stop(openId)}
        onRetry={(replyId) => retry(openId, replyId)}
        onEdit={(messageId, text) => edit(openId, messageId, text)}
        onVote={(replyId, v) => vote(openId, replyId, v)}
        onAnswer={(replyId, answers) => answer(openId, replyId, answers)}
        onRename={(t) => rename(openId, t)}
        pinned={!!session?.pinned}
        onPin={(p) => pin(openId, p)}
        onDelete={() => {
          remove(openId);
          setOpenId(null);
        }}
        onBack={() => {
          backTo.current = openId;
          setOpenId(null);
        }}
      />
    );
  }

  return (
    <>
      <CardHeader serif title={ASSISTANT_NAME} actions={<><MemoryButton scope={userId} />{headerExtra}</>} />
      <div ref={gridRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-b-xl">
        <SessionGrid
          sessions={sessions}
          onNew={() => setOpenId(newId())}
          onOpen={setOpenId}
          onRename={rename}
          onPin={pin}
          onMove={moveTo}
          onDelete={remove}
        />
      </div>
    </>
  );
}
