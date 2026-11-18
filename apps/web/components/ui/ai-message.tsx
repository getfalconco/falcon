"use client";

import { cn } from "@/lib/utils";
import { Check, Copy, Pencil, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

const COPIED_RESET_MS = 1600;
const ACTION_STAGGER_MS = 30;

/**
 * The reveal is CSS so it needs no state and cannot desync from the pointer.
 * `motion`'s `animate` target was not being re-applied on state change here, and
 * a hover fade does not need a spring — a 200ms ease-out is the whole effect.
 */
const ACTION_STYLES = `
.ai-message-action {
  opacity: 0;
  transform: translateX(var(--ai-message-slide)) scale(0.9);
  transition:
    opacity 200ms cubic-bezier(.23, 1, .32, 1),
    transform 200ms cubic-bezier(.23, 1, .32, 1),
    background-color 150ms ease,
    color 150ms ease;
}
.ai-message-action-agent { --ai-message-slide: -6px; }
.ai-message-action-user { --ai-message-slide: 6px; }
.ai-message-root:hover .ai-message-action,
.ai-message-root:focus-within .ai-message-action {
  opacity: 1;
  transform: translateX(0) scale(1);
}
.ai-message-pop { animation: ai-message-pop 250ms cubic-bezier(.23, 1, .32, 1); }
@keyframes ai-message-pop {
  0% { transform: scale(1); }
  45% { transform: scale(1.25); }
  100% { transform: scale(1); }
}
/* Touch screens have no hover: keep the actions visible. */
@media (hover: none) {
  .ai-message-action { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ai-message-action { transition-duration: 0ms; transition-delay: 0ms !important; transform: none; }
  .ai-message-root:hover .ai-message-action,
  .ai-message-root:focus-within .ai-message-action { transform: none; }
  .ai-message-pop { animation: none; }
}
`;

export type AIMessageAuthor = "user" | "assistant";

export type AIMessageProps = {
  /** Rendered to the side of the bubble — an avatar or an orb. */
  avatar?: ReactNode;
  /**
   * Draw the tinted bubble. Turn it off for assistant turns that carry their own
   * surfaces — reasoning traces, tool calls, diffs — where a bubble around a
   * stack of cards reads as a box inside a box.
   */
  bubble?: boolean;
  children: ReactNode;
  className?: string;
  /** Plain text handed to the clipboard. Omit to hide the copy action. */
  copyText?: string;
  /**
   * Who wrote it. Named `from` rather than `role` on purpose: `role` is an ARIA
   * attribute, and a component prop of that name misleads both readers and
   * accessibility linters.
   */
  from?: AIMessageAuthor;
  onRetry?: () => void;
  /** Label of the retry action ("Retry" by default; "Regenerate" for a finished reply). */
  retryLabel?: string;
  /** Edit this message (the viewer's last message: edit and send again). */
  onEdit?: () => void;
  /**
   * Keep the action row's height even while it is empty (a reply still
   * streaming), so the thread does not jump when the actions arrive.
   */
  reserveActions?: boolean;
  onVote?: (vote: "up" | "down") => void;
  /** Preformatted timestamp, e.g. "14:32". */
  timestamp?: string;
};

/*
 * Theme: the shadcn colour names of the original (foreground, background,
 * muted, muted-foreground) are swapped for Falcon's workspace tokens (solid,
 * fore, surface-2, quiet, line), which follow the app's light and dark themes.
 */

/**
 * A chat message with actions that stay out of the way.
 *
 * The action row slides out of the bubble's own edge rather than fading in from
 * nowhere, so it reads as belonging to that message. It is revealed on hover and
 * on focus-within, because a hover-only control row is unreachable by keyboard.
 */
export type MessageActionsProps = {
  copyText?: string;
  from?: AIMessageAuthor;
  onRetry?: () => void;
  retryLabel?: string;
  onEdit?: () => void;
  onVote?: (vote: "up" | "down") => void;
  /** The vote already given (a reloaded reply). */
  vote?: "up" | "down" | null;
  /**
   * "hover": hidden until the message is hovered or focused (inside AIMessage).
   * "visible": always shown (a finished reply's footer, components/ui/streaming-text.tsx).
   */
  reveal?: "hover" | "visible";
};

/** Copy, edit, retry and the feedback pair, as icon buttons. AIMessage shows them under the bubble; a reply footer can show them on its own. */
export const MessageActions = ({ copyText, from = "assistant", onRetry, retryLabel = "Retry", onEdit, onVote, vote: given = null, reveal = "hover" }: MessageActionsProps) => {
  const [hasCopied, setHasCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(given);

  const isUser = from === "user";

  useEffect(() => {
    if (!hasCopied) {
      return;
    }
    const timeout = setTimeout(() => setHasCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timeout);
  }, [hasCopied]);

  const copy = async () => {
    if (!copyText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(copyText);
      setHasCopied(true);
    } catch {
      // A blocked clipboard is not worth interrupting the conversation over.
    }
  };

  const actions = [
    copyText
      ? {
          active: hasCopied,
          icon: hasCopied ? Check : Copy,
          key: "copy",
          label: hasCopied ? "Copied" : "Copy",
          onClick: copy,
        }
      : null,
    onEdit
      ? {
          active: false,
          icon: Pencil,
          key: "edit",
          label: "Edit",
          onClick: onEdit,
        }
      : null,
    onRetry
      ? {
          active: false,
          icon: RotateCcw,
          key: "retry",
          label: retryLabel,
          onClick: onRetry,
        }
      : null,
    // Voting on your own message makes no sense, so the feedback pair is
    // assistant-only even when the consumer passes `onVote` for the thread.
    onVote && !isUser
      ? {
          active: vote === "up",
          icon: ThumbsUp,
          key: "up",
          label: "Good response",
          onClick: () => {
            setVote("up");
            onVote("up");
          },
        }
      : null,
    onVote && !isUser
      ? {
          active: vote === "down",
          icon: ThumbsDown,
          key: "down",
          label: "Bad response",
          onClick: () => {
            setVote("down");
            onVote("down");
          },
        }
      : null,
  ].filter((action): action is NonNullable<typeof action> => action !== null);

  const hover = reveal === "hover";
  return (
    <>
      {/* Always mounted, only faded — mounting the row on hover changed its
          height, so every message below jumped as the pointer moved down a
          thread. The reveal is plain CSS rather than a motion `animate`
          target: the group already knows about hover and focus-within, so no
          state, no listeners, and the row cannot get stuck half-revealed. */}
      {actions.map((action, index) => {
        const Icon = action.icon;
        return (
          <button
            aria-label={action.label}
            aria-pressed={action.key === "up" || action.key === "down" ? action.active : undefined}
            title={action.label}
            className={cn(
              "cursor-pointer rounded-lg p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-line/25",
              hover ? "ai-message-action" : "transition-colors duration-150",
              hover && (isUser ? "ai-message-action-user" : "ai-message-action-agent"),
              action.active
                ? "text-fore"
                : "text-quiet hover:bg-line/[0.05] hover:text-fore"
            )}
            key={action.key}
            onClick={action.onClick}
            style={hover ? { transitionDelay: `${index * ACTION_STAGGER_MS}ms` } : undefined}
            type="button"
          >
            <Icon
              aria-hidden="true"
              className={
                action.key === "copy" && hasCopied
                  ? "ai-message-pop"
                  : undefined
              }
              key={action.key === "copy" && hasCopied ? "copied" : "idle"}
              size={14}
            />
          </button>
        );
      })}
    </>
  );
};

const AIMessage = ({
  avatar,
  bubble = true,
  children,
  className,
  copyText,
  onRetry,
  retryLabel = "Retry",
  onEdit,
  reserveActions = false,
  onVote,
  from = "assistant",
  timestamp,
}: AIMessageProps) => {
  const isUser = from === "user";

  return (
    <div
      className={cn(
        // The reveal is scoped to this class rather than Tailwind's `group`, so a
        // `group` ancestor elsewhere on the page cannot reveal every row at once.
        "ai-message-root flex w-full gap-2.5",
        isUser ? "flex-row-reverse" : "flex-row",
        className
      )}
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a static, local stylesheet with no interpolation */}
      <style dangerouslySetInnerHTML={{ __html: ACTION_STYLES }} />

      {avatar ? <div className="mt-0.5 shrink-0">{avatar}</div> : null}

      <div className={cn("flex min-w-0 flex-col gap-1", isUser && "items-end")}>
        <div
          className={cn(
            // min(…, 100%): never wider than a narrow column (the Desk results panel can leave the chat ~400px).
            "w-fit max-w-[min(65ch,100%)] text-sm leading-relaxed",
            bubble && "rounded-2xl px-3.5 py-2.5",
            bubble && isUser && "rounded-br-md bg-solid text-solid-ink",
            bubble && !isUser && "rounded-bl-md bg-surface-2 text-fore",
            !bubble && "text-fore"
          )}
        >
          {children}
        </div>

        {timestamp || copyText || onRetry || onEdit || onVote || reserveActions ? (
          <div
            className={cn(
              "flex items-center gap-1 px-1",
              reserveActions && "min-h-[26px]",
              isUser ? "flex-row-reverse" : "flex-row"
            )}
          >
            {/* The timestamp comes first so it stays pinned to the edge the
                bubble is anchored to — left for the assistant, right for the
                user. Putting the (always-mounted, invisible) action slots before
                it pushed it toward the middle of the row, where it read as
                floating in nothing. */}
            {timestamp ? (
              <span className="text-quiet text-xs tabular-nums">
                {timestamp}
              </span>
            ) : null}

            <MessageActions copyText={copyText} from={from} onRetry={onRetry} retryLabel={retryLabel} onEdit={onEdit} onVote={onVote} />
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AIMessage;
