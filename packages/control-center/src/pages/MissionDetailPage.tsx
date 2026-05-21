// Mission Detail — the core screen.
//
// Rewritten in K3.5 to drop the K1 mock-driven three-pane layout.
// What lives here now is the LIVE coordination view: timeline pulled
// from `/missions/:id/timeline` (polling every 2s), a follow-up input
// that posts to the linked team-runtime thread. K4+ will reintroduce
// a work-plan / approvals pane once those have real backing data.
//
// Missions without a `threadId` are bootstrap-demo fixtures or stale
// records — they render an explanatory placeholder rather than the
// K1 fake three-pane that hardcoded MSN-1042-specific content.

import { useCallback, useState } from "react";

import type { ActivityEvent, Mission } from "../api/mission-api";
import {
  useMission,
  useMissions,
  useSendMissionMessage,
  useTimeline,
} from "../api/useMissionData";
import { formatTimeOfDay } from "../util/format-time";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { StatusTag } from "../components/atoms";
import { useAppState } from "../state/AppState";
import { formatDurationMs, groupTimelineForReplay, type ToolProcessItem } from "../state/toolReplay";

export function MissionDetailPage({ missionId }: { missionId: string }) {
  const { setRoute } = useAppState();
  const missions = useMissions([]);
  const listMission = missions.value.find((m) => m.id === missionId) ?? null;
  const missionDetail = useMission(missionId, listMission, { pollIntervalMs: 2000 });
  const mission = missionDetail.value ?? listMission;

  if (!mission && !missions.isLive && !missionDetail.isLive) {
    return (
      <div className="page" style={{ padding: 28 }}>
        <p className="muted">Loading mission…</p>
      </div>
    );
  }

  if (!mission) {
    return (
      <div className="page" style={{ padding: 28 }}>
        <p className="muted">
          Mission <span className="mono">{missionId}</span> is no longer
          available. It may have been archived.
        </p>
        <button type="button" className="btn primary" onClick={() => setRoute("missions")}>
          ← Back to Missions
        </button>
      </div>
    );
  }

  return (
    <>
      <MissionBar mission={mission} onBack={() => setRoute("missions")} />
      {mission.threadId ? (
        <LiveMissionView mission={mission} />
      ) : (
        <UnlinkedMissionView mission={mission} />
      )}
    </>
  );
}

function MissionBar({ mission, onBack }: { mission: Mission; onBack: () => void }) {
  return (
    <div className="mission-bar">
      <button type="button" className="btn ghost" onClick={onBack} style={{ padding: "2px 6px" }}>
        ← Missions
      </button>
      <span className="mono faint" style={{ fontSize: 10.5 }}>{mission.shortId}</span>
      <h2 style={{ marginLeft: 4 }}>{mission.title}</h2>
      <StatusTag status={mission.status} />
      <div className="meta">created {mission.createdAt} · {mission.modeLabel}</div>
    </div>
  );
}

function UnlinkedMissionView({ mission }: { mission: Mission }) {
  // bootstrap-demo missions land here. They have no team-runtime
  // thread, so there's no live timeline to render. We don't fake one.
  return (
    <div className="page" style={{ padding: 28, maxWidth: 720 }}>
      <p style={{ marginTop: 0 }}>{mission.desc}</p>
      <div
        className="card"
        style={{ marginTop: 16, padding: 16, background: "var(--surface)" }}
      >
        <div className="label" style={{ fontSize: 11, marginBottom: 6 }}>
          No linked coordination thread
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
          This mission was imported via <code>POST /missions/bootstrap-demo</code>{" "}
          (design fixture) and has no live agent team attached. To run a real
          coordination, start a fresh mission with the <b>New mission</b>{" "}
          button on the Missions page.
        </div>
      </div>
    </div>
  );
}

function LiveMissionView({ mission }: { mission: Mission }) {
  const timeline = useTimeline(mission.id, []);
  const send = useSendMissionMessage();
  const [pending, setPending] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acceptedNotice, setAcceptedNotice] = useState<string | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const finalAnswer = latestFinalAnswer(timeline.value);

  const onSend = useCallback(async () => {
    const content = pending.trim();
    if (!content || submitting) return;
    setSubmitting(true);
    setError(null);
    setAcceptedNotice(null);
    try {
      await send({ missionId: mission.id, content });
      setPending("");
      setAcceptedNotice("Follow-up accepted. The team is working; updates will appear in the timeline.");
      timeline.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [pending, submitting, send, mission.id, timeline]);

  return (
    <div className="mission-shell mission-shell-single">
      <div className="mission-pane center mission-detail-pane">
        <div className="timeline-head">
          <span className="lbl label">Activity timeline</span>
          <span className="mono faint" style={{ fontSize: 10.5, marginRight: 8 }}>
            {timeline.value.length} event{timeline.value.length === 1 ? "" : "s"}
          </span>
          <span className="spacer" />
          {timeline.error && (
            <span className="mono" style={{ fontSize: 10.5, color: "var(--danger)" }}>
              {timeline.error}
            </span>
          )}
        </div>
        <div className="mission-detail-scroll">
          <section className="card thinking-card">
            <div className="thinking-card-head">
              <div>
                <div className="label" style={{ fontSize: 11 }}>Thinking record</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  Tool calls, progress, and source-gathering steps
                </div>
              </div>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setThinkingExpanded((value) => !value)}
              >
                {thinkingExpanded ? "Collapse" : "Expand"}
              </button>
            </div>
            {thinkingExpanded && (
              <div className="timeline">
                {timeline.value.length === 0 ? (
                  <div className="muted" style={{ padding: 28, textAlign: "center", fontSize: 11.5 }}>
                    {timeline.isLive
                      ? "No activity yet. Agents will reply here as they work — the timeline refreshes every 2 seconds."
                      : "Loading activity…"}
                  </div>
                ) : (
                  groupTimelineForReplay(timeline.value).map((item) =>
                    item.kind === "event" ? (
                      <LiveTimelineRow key={item.event.id} event={item.event} />
                    ) : (
                      <ToolProcessRow key={item.id} process={item} />
                    )
                  )
                )}
              </div>
            )}
          </section>
          {finalAnswer && (
            <section className="card final-answer-card">
              <div className="label" style={{ fontSize: 11, marginBottom: 8 }}>
                Final answer
              </div>
              <Markdown text={finalAnswer.text} />
            </section>
          )}
        </div>
        <div
          className="row"
          style={{
            borderTop: "1px solid var(--border)",
            padding: 12,
            gap: 8,
            background: "var(--surface)",
            alignItems: "flex-end",
          }}
        >
          <textarea
            aria-label="Follow-up message to mission team"
            value={pending}
            onChange={(e) => {
              setPending(e.target.value);
              if (acceptedNotice) setAcceptedNotice(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void onSend();
              }
            }}
            placeholder="Follow up with the team… (⌘↩ to send)"
            rows={2}
            disabled={submitting}
            style={{
              flex: 1,
              padding: "8px 10px",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-sm)",
              color: "var(--text)",
              fontFamily: "var(--font-sans)",
              fontSize: 12.5,
              resize: "vertical",
              minHeight: 38,
            }}
          />
          <button
            type="button"
            className="btn primary"
            disabled={submitting || pending.trim().length === 0}
            onClick={onSend}
          >
            <Icon name="send" size={13} /> {submitting ? "Sending…" : "Send"}
          </button>
        </div>
        {error && (
          <div role="alert" style={{ padding: "6px 12px", color: "var(--danger)", fontSize: 11.5 }}>
            {error}
          </div>
        )}
        {acceptedNotice && !error && (
          <div style={{ padding: "6px 12px", color: "var(--muted)", fontSize: 11.5 }}>
            {acceptedNotice}
          </div>
        )}
      </div>
    </div>
  );
}

function latestFinalAnswer(events: ActivityEvent[]): ActivityEvent | null {
  const candidates = events.filter(
    (event) =>
      event.kind === "thought" &&
      event.text.trim().length > 0 &&
      (event.runtime?.route === "lead-role" || event.actor === "role-lead")
  );
  return candidates.at(-1) ?? null;
}

function ToolProcessRow({ process }: { process: ToolProcessItem }) {
  const toolNames = [...new Set(process.toolEvents.map((event) => event.runtime?.toolName).filter(Boolean))];
  const statusLabel =
    process.status === "failed" ? "failed" : process.status === "running" ? "running" : "completed";
  const resultCount = process.toolEvents.filter((event) => event.runtime?.toolPhase === "result").length;
  const progressCount = process.toolEvents.filter((event) => event.runtime?.toolPhase === "progress").length;
  const duration = formatDurationMs(process.startMs, process.endMs);
  const emph = process.status === "failed" ? "danger" : process.status === "completed" ? "success" : undefined;

  return (
    <div className="tl-event tool-process" data-kind="tool">
      <div className="tl-time mono">{formatTimeOfDay(process.startMs)}</div>
      <div className="tl-gutter">
        <div className="tl-marker" />
      </div>
      <div className="tl-body tool-process-body" data-emph={emph}>
        <div className="tl-actor">
          {process.actor}
          <span className="role-mini">
            thought process · {statusLabel} · {duration}
          </span>
        </div>
        <div className="tool-process-summary">
          <span>{toolNames.length ? toolNames.join(", ") : "tool chain"}</span>
          <span>{process.toolEvents.length} step{process.toolEvents.length === 1 ? "" : "s"}</span>
          <span>{resultCount} result{resultCount === 1 ? "" : "s"}</span>
          {progressCount > 0 && <span>{progressCount} progress</span>}
        </div>
        {process.finalThought && (
          <div className="tl-msg tool-process-final">
            <Markdown text={process.finalThought.text} />
          </div>
        )}
        <details className="tool-process-details">
          <summary>Show tool calls, progress, and results</summary>
          <div className="tool-process-steps">
            {process.toolEvents.map((event) => (
              <div key={event.id} className="tool-process-step" data-phase={event.runtime?.toolPhase}>
                <div className="step-head">
                  <span className="mono">{event.runtime?.toolPhase ?? "tool"}</span>
                  <span>{event.runtime?.toolName ?? "tool"}</span>
                  <span className="mono faint">{event.t ?? formatTimeOfDay(event.tMs)}</span>
                </div>
                <div className="step-text">{event.text}</div>
                <ToolEventInspector event={event} />
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

function LiveTimelineRow({ event }: { event: ActivityEvent }) {
  const isUser = event.kind === "plan" && event.actor === "user";
  const isFailure = event.kind === "recovery";
  const emph = isFailure ? "danger" : event.emph;
  const isToolEvent = event.kind === "tool";
  const toolPhase = event.runtime?.toolPhase;
  const toolName = event.runtime?.toolName;
  const kindLabel =
    isToolEvent && toolPhase === "call"
      ? `tool → ${toolName ?? "?"}`
      : isToolEvent && toolPhase === "progress"
        ? `tool · ${toolName ?? "?"}`
      : isToolEvent && toolPhase === "result"
        ? `tool ← ${toolName ?? "?"}`
        : event.kind;

  // PR K3.6: tool events get an expandable inspector. The inline
  // `text` is already a capped human-readable preview; the
  // expanded view shows the full structured JSON (call args) or
  // full result content (truncated only at the 8 kB server-side
  // cap). Without this the timeline is a black box —
  // "returned (2.0 kB)" with no way to see WHAT.
  const expandable =
    isToolEvent &&
    ((toolPhase === "call" && event.runtime?.callInput) ||
      (toolPhase === "progress" && event.runtime?.progressDetail) ||
      (toolPhase === "result" && event.runtime?.resultContent));

  return (
    <div className="tl-event" data-kind={event.kind}>
      <div className="tl-time mono">{event.t ?? formatTimeOfDay(event.tMs)}</div>
      <div className="tl-gutter">
        <div className="tl-marker" />
      </div>
      <div className="tl-body" data-emph={emph}>
        <div className="tl-actor">
          {isUser ? "You" : event.actor}
          <span className="role-mini">{kindLabel}</span>
        </div>
        <div
          className="tl-msg"
          style={{
            whiteSpace: "pre-wrap",
            ...(isToolEvent
              ? {
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  color: "var(--text-muted)",
                  background: "var(--surface)",
                  padding: "4px 8px",
                  borderRadius: "var(--r-sm)",
                  border: "1px solid var(--border)",
                }
              : {}),
          }}
        >
          {event.text}
        </div>
        {expandable && <ToolEventInspector event={event} />}
      </div>
    </div>
  );
}

function ToolEventInspector({ event }: { event: ActivityEvent }) {
  const toolPhase = event.runtime?.toolPhase;
  const callInput = event.runtime?.callInput;
  const progressDetail = event.runtime?.progressDetail;
  const resultContent = event.runtime?.resultContent;
  const resultTruncated = event.runtime?.resultTruncated === "true";
  const progressTruncated = event.runtime?.progressTruncated === "true";

  const body =
    toolPhase === "call" && callInput
      ? prettyJson(callInput)
      : toolPhase === "progress" && progressDetail
        ? prettyJson(progressDetail)
      : toolPhase === "result" && resultContent
        ? resultContent
        : null;
  if (!body) return null;
  const label =
    toolPhase === "call"
      ? "Show full arguments"
      : toolPhase === "progress"
        ? progressTruncated
          ? "Show progress detail (truncated at 16 kB)"
          : "Show progress detail"
      : resultTruncated
        ? "Show captured result (truncated at 8 kB)"
        : "Show full result";

  return (
    <details style={{ marginTop: 4 }}>
      <summary
        style={{
          cursor: "pointer",
          fontSize: 10.5,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          padding: "2px 0",
          userSelect: "none",
        }}
      >
        {label}
      </summary>
      <pre
        style={{
          marginTop: 4,
          padding: 8,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-sm)",
          fontSize: 11,
          lineHeight: 1.5,
          color: "var(--text)",
          maxHeight: 400,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {body}
      </pre>
    </details>
  );
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
