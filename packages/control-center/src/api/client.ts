// Typed API client for the Control Center.
//
// Design constraints (carried over from PR I's vanilla apiFetch):
//   1. Bearer token is read from the AppState reactive store each call —
//      so if the user pastes a new token mid-flight we use it immediately.
//   2. Stale 401 defense: a 401 response only clears the token if the
//      token used FOR THAT REQUEST is still the current one. Otherwise
//      the user already replaced it; ignore the stale 401.
//   3. The client is dispatch-free: it throws on auth failure and lets
//      the calling hook react. Side-effects (clearing storage, swapping
//      to no-token page) live in the calling hook, not here.

export class ApiError extends Error {
  readonly status: number;
  readonly pathname: string;
  constructor(status: number, pathname: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.pathname = pathname;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(pathname: string, message = "unauthorized") {
    super(401, pathname, message);
    this.name = "UnauthorizedError";
  }
}

export interface ApiClientOptions {
  /**
   * Returns the token to use for the next request. Reading via callback
   * (not a snapshot) so the client picks up token changes between calls
   * without being re-instantiated.
   */
  getToken(): string | null;
  /**
   * Called when a request returned 401 AND the captured token still matches
   * the current token. The caller decides what to do (clear storage,
   * redirect to no-token page, etc.).
   */
  onUnauthorized?(pathname: string): void;
}

interface SendOptions {
  /**
   * Optional/admin-only panels should report their own 401 state without
   * clearing the whole dashboard token. Normal product calls keep the
   * existing clear-on-401 behavior.
   */
  clearOnUnauthorized?: boolean;
}

export function createApiClient(options: ApiClientOptions) {
  async function send<T>(
    method: "GET" | "POST" | "PUT",
    pathname: string,
    body?: unknown,
    sendOptions: SendOptions = {}
  ): Promise<T> {
    const requestToken = options.getToken();
    const headers: Record<string, string> = { accept: "application/json" };
    if (requestToken) {
      headers.authorization = `Bearer ${requestToken}`;
      headers["x-turnkeyai-token"] = requestToken;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(pathname, init);
    if (!response.ok) {
      const message = await readApiErrorMessage(response, pathname);
      if (response.status === 401) {
        if (sendOptions.clearOnUnauthorized !== false && options.getToken() === requestToken) {
          options.onUnauthorized?.(pathname);
        }
        throw new UnauthorizedError(pathname, message);
      }
      throw new ApiError(response.status, pathname, message);
    }
    // 204 No Content is rare on our routes today but be defensive.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    get: <T>(pathname: string) => send<T>("GET", pathname),
    getNoAuthReset: <T>(pathname: string) =>
      send<T>("GET", pathname, undefined, { clearOnUnauthorized: false }),
    post: <T>(pathname: string, body?: unknown) => send<T>("POST", pathname, body),
    postNoAuthReset: <T>(pathname: string, body?: unknown) =>
      send<T>("POST", pathname, body, { clearOnUnauthorized: false }),
    put: <T>(pathname: string, body?: unknown) => send<T>("PUT", pathname, body),
    putNoAuthReset: <T>(pathname: string, body?: unknown) =>
      send<T>("PUT", pathname, body, { clearOnUnauthorized: false }),
  };
}

async function readApiErrorMessage(response: Response, pathname: string): Promise<string> {
  const fallback = `${pathname} responded ${response.status}`;
  let text = "";
  try {
    text = await response.text();
  } catch {
    return fallback;
  }
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const message = extractErrorMessage(parsed);
    if (message) return message;
  } catch {
    // Non-JSON error bodies still make useful operator feedback when
    // they are short plain text.
  }
  return truncateErrorMessage(trimmed);
}

function extractErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return truncateErrorMessage(value.trim());
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return truncateErrorMessage(candidate.trim());
    }
  }
  return null;
}

function truncateErrorMessage(value: string): string {
  const maxLength = 320;
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}
