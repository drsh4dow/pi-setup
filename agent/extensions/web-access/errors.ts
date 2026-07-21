import { Data } from "effect";

export class WebAccessError extends Data.TaggedError("WebAccessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function webAccessError(
  message: string,
  cause?: unknown,
): WebAccessError {
  return new WebAccessError(
    cause === undefined ? { message } : { message, cause },
  );
}

export function asError(error: unknown): WebAccessError {
  return error instanceof WebAccessError
    ? error
    : webAccessError(errorMessage(error), error);
}
