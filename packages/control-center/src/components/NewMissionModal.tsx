// New Mission modal (PR K3.5).
//
// Lightweight — title + goal description. The daemon will spawn the
// linked team-runtime thread and post the initial user message; the
// modal just collects what the user wants done and hands off. On
// success the caller (App.tsx) navigates to Mission Detail so the user
// can watch the coordination engine pick it up.
//
// No mode picker / agent picker yet — K4+ can expose those once we
// have a real story for capability gating.

import { useCallback, useEffect, useRef, useState } from "react";

import { useCreateMission } from "../api/useMissionData";

const MODES: Array<{ id: string; label: string }> = [
  { id: "research", label: "Research and summarize" },
  { id: "monitor", label: "Monitor and update" },
  { id: "browser", label: "Operate browser" },
  { id: "review", label: "Review and verify" },
  { id: "investigation", label: "Multi-agent investigation" },
  { id: "custom", label: "Custom" },
];

export function NewMissionModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (missionId: string) => void;
}) {
  const createMission = useCreateMission();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [mode, setMode] = useState("research");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Reset form on re-open. Esc closes.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDesc("");
    setMode("research");
    setSubmitting(false);
    setError(null);
    // Focus title input after the dialog mounts. Tiny timeout so the
    // browser actually shows the modal before stealing focus (which
    // otherwise can interrupt the click that opened it on some browsers).
    const t = setTimeout(() => titleRef.current?.focus(), 0);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const handleSubmit = useCallback(async () => {
    const trimmedTitle = title.trim();
    const trimmedDesc = desc.trim();
    if (!trimmedTitle) {
      setError("Title is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const mission = await createMission({
        title: trimmedTitle,
        desc: trimmedDesc,
        mode,
      });
      onCreated(mission.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [title, desc, mode, createMission, onCreated]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--bg) 80%, transparent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        className="modal-panel card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 92vw)", maxWidth: "92vw" }}
      >
        <div className="card-hd">
          <h3 style={{ flex: 1 }}>New mission</h3>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="card-bd" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="label" style={{ fontSize: 11 }}>Title</span>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Research five competitor notes apps"
              disabled={submitting}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="label" style={{ fontSize: 11 }}>Goal / brief</span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Describe what you want the team to do. e.g. Compare pricing tiers across Notion, Reflect, Obsidian, Roam, Logseq. Highlight macOS-only features."
              rows={5}
              disabled={submitting}
              style={{ ...inputStyle, fontFamily: "var(--font-sans)", resize: "vertical" }}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="label" style={{ fontSize: 11 }}>Mode</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              disabled={submitting}
              style={inputStyle}
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <div
              role="alert"
              style={{
                padding: "8px 10px",
                background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
                borderRadius: "var(--r-sm)",
                color: "var(--danger)",
                fontSize: 11.5,
              }}
            >
              {error}
            </div>
          )}
          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" className="btn" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={handleSubmit}
              disabled={submitting || title.trim().length === 0}
            >
              {submitting ? "Creating…" : "Create mission"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-sm)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};
