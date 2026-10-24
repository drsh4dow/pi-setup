import { resolveOptions, type ClientOptions } from "./config.ts";

export class TimeoutError extends Error {}

export interface Client {
  getJson(path: string): Promise<unknown>;
}

export function createClient(options: ClientOptions, fetchImpl: typeof fetch = fetch): Client {
  const { baseUrl, timeoutMs, retryCount } = resolveOptions(options);

  async function attempt(url: string): Promise<Response> {
    try {
      return await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new TimeoutError(`${url} took longer than ${timeoutMs}ms`, { cause: error });
      }

      throw error;
    }
  }

  return {
    async getJson(path) {
      const url = `${baseUrl}${path}`;
      let response = await attempt(url);

      for (let retry = 0; retry < retryCount && response.status >= 500; retry++) {
        response = await attempt(url);
      }

      if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);

      return response.json();
    },
  };
}
