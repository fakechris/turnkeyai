import { useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
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
