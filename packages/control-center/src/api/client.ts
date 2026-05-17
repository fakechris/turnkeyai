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
  constructor(pathname: string) {
    super(401, pathname, "unauthorized");
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

export function createApiClient(options: ApiClientOptions) {
  async function send<T>(
    method: "GET" | "POST",
    pathname: string,
    body?: unknown
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
    if (response.status === 401) {
      if (options.getToken() === requestToken) {
        options.onUnauthorized?.(pathname);
      }
      throw new UnauthorizedError(pathname);
    }
    if (!response.ok) {
      throw new ApiError(
        response.status,
        pathname,
        `${pathname} responded ${response.status}`
      );
    }
    // 204 No Content is rare on our routes today but be defensive.
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    get: <T>(pathname: string) => send<T>("GET", pathname),
    post: <T>(pathname: string, body?: unknown) => send<T>("POST", pathname, body),
  };
}
