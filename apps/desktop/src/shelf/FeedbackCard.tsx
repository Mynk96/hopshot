import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { limits } from "shared";
import { Icon } from "./icons";

/**
 * "Is Hopshot useful to you?" — asked once, on the shelf, about a week in (ARCHITECTURE
 * §7.10). Rust decides when (`feedback_due`) and records that it was asked; answering or
 * dismissing retires it for good.
 *
 * Two steps so the common answer is one click: yes/no first, then an optional comment.
 */
export function FeedbackCard({
  onDone,
  onHeight,
  onToast,
}: {
  onDone: () => void;
  /** The shelf sizes its window to its content, so it needs this card's height. */
  onHeight: (px: number) => void;
  onToast: (text: string, kind?: "info" | "error") => void;
}) {
  const [useful, setUseful] = useState<boolean | null>(null);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => onHeight(element.offsetHeight));
    observer.observe(element);
    return () => {
      observer.disconnect();
      onHeight(0);
    };
  }, [onHeight]);

  const dismiss = () => {
    void invoke("dismiss_feedback").catch(() => undefined);
    onDone();
  };

  const send = async (withComment: boolean) => {
    if (useful === null) return;
    setSending(true);
    try {
      await invoke("send_feedback", { useful, comment: withComment ? comment : null });
      onToast("Thanks for telling us");
    } catch (error) {
      // Rust marks it asked before sending, so a failure never makes it ask again.
      console.error("could not send feedback", error);
      onToast("Couldn't send that, but thanks.", "error");
    }
    onDone();
  };

  return (
    <div
      ref={box}
      className="flex shrink-0 flex-col gap-2 px-3 py-2.5"
      style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}
    >
      {useful === null ? (
        <>
          <div className="flex items-start gap-2">
            <b className="flex-1 text-caption">Is Hopshot useful to you?</b>
            <button
              type="button"
              className="icon-btn size-5"
              aria-label="Not now"
              onClick={dismiss}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="btn btn-primary btn-compact text-caption"
              onClick={() => setUseful(true)}
            >
              Yes
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-compact text-caption"
              onClick={() => setUseful(false)}
            >
              Not really
            </button>
          </div>
        </>
      ) : (
        <>
          <span className="text-caption leading-4 text-text-2">
            {useful ? "Glad to hear it." : "Thanks for being honest."} Anything to add?
          </span>
          <textarea
            className="text-caption"
            rows={2}
            maxLength={limits.insights.feedbackCommentMaxChars}
            placeholder="Optional"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            style={{
              resize: "none",
              background: "var(--surface-solid)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "4px 6px",
              color: "var(--text)",
            }}
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              className="btn btn-primary btn-compact text-caption"
              disabled={sending}
              onClick={() => void send(true)}
            >
              Send
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-compact text-caption"
              disabled={sending}
              onClick={() => void send(false)}
            >
              Skip
            </button>
          </div>
        </>
      )}
    </div>
  );
}
