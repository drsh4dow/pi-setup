import { execFile } from "node:child_process";
import { Effect } from "effect";
import { asError } from "./errors.ts";

export function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number },
): Effect.Effect<Buffer, Error> {
  return Effect.tryPromise({
    try: (signal) =>
      new Promise<Buffer>((resolve, reject) => {
        execFile(
          command,
          args,
          {
            timeout: options.timeoutMs,
            maxBuffer: options.maxBuffer,
            signal,
          },
          (error, stdout, stderr) => {
            if (error) {
              Object.assign(error, { stderr });
              reject(error);
              return;
            }
            resolve(
              Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"),
            );
          },
        );
      }),
    catch: asError,
  });
}
