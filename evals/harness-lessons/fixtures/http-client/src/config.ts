export interface ClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  /** How many times to retry a request that failed with a 5xx. */
  readonly retryCount?: number;
}

export interface ResolvedOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retryCount: number;
}

export const DEFAULTS = { timeoutMs: 10_000, retryCount: 3 } as const;

export function resolveOptions(options: ClientOptions): ResolvedOptions {
  return {
    baseUrl: options.baseUrl.replace(/\/$/, ""),
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    retryCount: options.retryCount ?? DEFAULTS.retryCount,
  };
}
