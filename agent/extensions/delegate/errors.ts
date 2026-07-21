import { Data } from "effect";

export class DelegateError extends Data.TaggedError("DelegateError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DelegateTimeout extends Data.TaggedError("DelegateTimeout")<{
  readonly message: string;
}> {}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function delegateError(error: unknown): DelegateError {
  return error instanceof DelegateError
    ? error
    : new DelegateError({ message: errorMessage(error), cause: error });
}
