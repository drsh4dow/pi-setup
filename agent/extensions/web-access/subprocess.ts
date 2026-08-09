import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, type PlatformError, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { tagPid } from "../../lib/sacrifice.ts";
import { asError, webAccessError } from "./errors.ts";

export const runCommand = Effect.fn("runCommand")(
	function* (
		command: string,
		args: string[],
		options: { timeoutMs: number; maxBuffer: number },
	) {
		return yield* Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner.spawn(ChildProcess.make(command, args));
			yield* Effect.sync(() => tagPid(handle.pid));
			const collect = (
				stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
			) =>
				Stream.runFoldEffect(
					stream,
					() => Buffer.alloc(0),
					(output, chunk) =>
						output.length + chunk.length > options.maxBuffer
							? Effect.fail(
									webAccessError(
										`Command output exceeded ${options.maxBuffer} bytes`,
									),
								)
							: Effect.succeed(Buffer.concat([output, chunk])),
				);
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
				{ concurrency: "unbounded" },
			);
			if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
				return yield* Effect.fail(
					Object.assign(new Error(`${command} exited with code ${exitCode}`), {
						code: String(exitCode),
						stderr,
					}),
				);
			}
			return stdout;
		}).pipe(Effect.scoped, Effect.timeout(options.timeoutMs));
	},
	Effect.provide(BunServices.layer),
	Effect.mapError(asError),
);
