import { useState } from "react";

export interface CopyButtonProps {
  text: string;
  label?: string;
  /**
   * Called when clipboard.writeText rejects. Lets the caller surface a
   * fallback path (e.g. reveal a hidden <pre> the user can select
   * manually). Carries over the PR I vanilla behavior — gemini PR J1
   * review caught that the new component swallowed failures silently.
   */
  onCopyFailed?(): void;
}

export function CopyButton({ text, label = "Copy", onCopyFailed }: CopyButtonProps) {
  // Three transient states for the button label: idle ("Copy"),
  // success ("Copied"), failure ("Copy failed"). All return to idle
  // after a short timeout so the button doesn't lie about its state.
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const handleClick = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setStatus("copied");
        window.setTimeout(() => setStatus("idle"), 1_200);
      })
      .catch(() => {
        setStatus("failed");
        onCopyFailed?.();
        window.setTimeout(() => setStatus("idle"), 1_500);
      });
  };

  return (
    <button
      type="button"
      className={`copy${status === "copied" ? " copied" : ""}`}
      onClick={handleClick}
    >
      {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label}
    </button>
  );
}
