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
  return {
    async get<T>(pathname: string): Promise<T> {
      const requestToken = options.getToken();
      const headers: Record<string, string> = { accept: "application/json" };
      if (requestToken) {
        headers.authorization = `Bearer ${requestToken}`;
        headers["x-turnkeyai-token"] = requestToken;
      }
      const response = await fetch(pathname, { headers });
      if (response.status === 401) {
        // Stale-401 defense: only fire the unauthorized callback if the
        // token used for this request is still the one stored in state.
        // If the user just pasted a new token, we must NOT wipe it.
        if (options.getToken() === requestToken) {
          options.onUnauthorized?.(pathname);
        }
        throw new UnauthorizedError(pathname);
      }
      if (!response.ok) {
        throw new ApiError(response.status, pathname, `${pathname} responded ${response.status}`);
      }
      return (await response.json()) as T;
    },
  };
}
