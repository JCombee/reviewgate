import { useEffect, useState } from "react";
import { fetchUpdateCheck } from "../lib/reviewClient.js";

const UPDATE_COMMAND = "reviewgate update";

/** The one-time result of the update check, once it settles. */
type CheckState =
  | { status: "pending" }
  | { status: "failed" }
  | { status: "resolved"; updateAvailable: boolean };

/**
 * A small header badge that appears only when a newer ReviewGate release exists
 * (§5, FR-008). Checks once per page load; renders nothing while the check is
 * outstanding, once it comes back with no update, or if it fails outright — a failed
 * check is silent, matching the rest of ReviewGate's "never block/alarm the reviewer
 * over a non-critical failure" posture. Clicking the badge opens a modal with the
 * exact update command and a copy-to-clipboard control.
 */
export function UpdatePrompt() {
  const [check, setCheck] = useState<CheckState>({ status: "pending" });
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Once per page load: this component is mounted exactly once, statically, in
  // App.tsx's header — an empty dependency array is the correct "once" here.
  useEffect(() => {
    let cancelled = false;
    fetchUpdateCheck()
      .then((result) => {
        if (cancelled) return;
        setCheck({ status: "resolved", updateAvailable: result.updateAvailable });
      })
      .catch(() => {
        if (cancelled) return;
        setCheck({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Escape closes the modal; the listener only exists while it's open, so nothing
  // leaks across repeated opens/closes or after unmount.
  useEffect(() => {
    if (!isModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen]);

  if (check.status !== "resolved" || !check.updateAvailable) return null;

  const copy = () => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(UPDATE_COMMAND).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        // Denied/unsupported clipboard write: nothing to surface to the reviewer.
      },
    );
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsModalOpen(true)}
        className="rounded border border-[var(--rg-border)] px-2 py-0.5 font-semibold"
        style={{ color: "var(--rg-approve)" }}
      >
        Update available
      </button>

      {isModalOpen && (
        <div className="rg-modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div
            className="rg-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Update available"
            onClick={(e) => e.stopPropagation()}
          >
            <p>A newer version of ReviewGate is available. Run:</p>
            <div className="rg-modal-command">
              <code className="rg-code">{UPDATE_COMMAND}</code>
              <button type="button" onClick={copy} className="rg-modal-copy">
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="rg-modal-actions">
              <button type="button" onClick={() => setIsModalOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
