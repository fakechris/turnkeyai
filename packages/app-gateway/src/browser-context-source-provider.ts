// Live browser sessions → ContextSource list (PR K3).
//
// Mission Detail's right pane wants to show what the agents are
// currently using. K2 only had the static FileContextSourceRegistry —
// useful for docs/folders/APIs the user pinned, but blind to browser
// sessions the bridge actually has open. This provider asks the bridge
// for its live sessions, maps each to a ContextSource record using the
// same id scheme as the activity-event recorder
// (`ctx.browser.session.<sessionId>`), and the mission-routes handler
// merges the result alongside the registry list.
//
// Read-only: this never persists. Sessions disappear from the list when
// the bridge closes them. The registry remains authoritative for
// non-browser context sources.

import type { ContextSource } from "@turnkeyai/core-types/mission";
import type { BrowserSession } from "@turnkeyai/core-types/team";

import { browserSessionContextId } from "./bridge-mission-activity-recorder";

export interface BrowserContextSourceProvider {
  listLive(): Promise<ContextSource[]>;
}

export interface BrowserSessionLister {
  listSessions(): Promise<BrowserSession[]>;
  transportMode: string;
  transportLabel: string;
}

export interface CreateBrowserContextSourceProviderOptions {
  browserBridge: BrowserSessionLister;
}

export function createBrowserContextSourceProvider(
  options: CreateBrowserContextSourceProviderOptions
): BrowserContextSourceProvider {
  return {
    async listLive(): Promise<ContextSource[]> {
      let sessions: BrowserSession[];
      try {
        sessions = await options.browserBridge.listSessions();
      } catch {
        // The provider must never block /mission-context-sources from
        // returning. A transient bridge failure (e.g. relay heartbeat
        // glitch) should just hide live sessions, not 500 the read.
        return [];
      }
      return sessions.map((session) => sessionToContextSource(session, options.browserBridge));
    },
  };
}

function sessionToContextSource(
  session: BrowserSession,
  bridge: BrowserSessionLister
): ContextSource {
  // `lastUse` left blank — clients format relative-time on display from
  // `lastUseAtMs`. The daemon doesn't own localized formatting (general
  // rule: server returns raw timestamps; client formats).
  return {
    id: browserSessionContextId(session.browserSessionId),
    kind: "browser",
    title: `Browser session ${session.browserSessionId}`,
    url: "",
    state: mapSessionStatus(session.status),
    lastUse: "",
    lastUseAtMs: session.lastActiveAt,
    transport: bridge.transportLabel,
    session: session.browserSessionId,
  };
}

function mapSessionStatus(status: BrowserSession["status"]): string {
  switch (status) {
    case "ready":
    case "busy":
      return "attached";
    case "starting":
      return "starting";
    case "disconnected":
      return "detached";
    case "closed":
      return "closed";
    default:
      return status;
  }
}
