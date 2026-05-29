import type { DaemonAuthConfig } from "./daemon-auth";

export interface ControlCenterStartupBannerInput {
  port: number;
  assetAvailable: boolean;
  authMode: DaemonAuthConfig["authMode"];
  tokenGenerated: boolean;
  configFile: string;
}

export function buildControlCenterStartupBanner(input: ControlCenterStartupBannerInput): string[] {
  if (!input.assetAvailable) {
    return ["control center: (bundle not found; rebuild @turnkeyai/cli)"];
  }

  const appUrl = `http://127.0.0.1:${input.port}/app`;
  if (input.authMode === "disabled") {
    return [`control center: ${appUrl}`];
  }

  const lines = [
    "control center: run `turnkeyai app` to open with daemon auth",
    "  no install: `npx @turnkeyai/cli app`",
    "  source checkout: `npm run app -- --no-open`",
    `  direct URL ${appUrl} requires a token pasted in the browser`,
    "auth: token required via x-turnkeyai-token or Authorization: Bearer <token>",
  ];
  if (input.tokenGenerated) {
    lines.push(`auth: generated token written to ${input.configFile}`);
  }
  return lines;
}
