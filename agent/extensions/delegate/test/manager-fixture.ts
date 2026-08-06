import type {
	AgentSessionEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Deferred, Effect } from "effect";
import type { DelegateSnapshot } from "../contract.ts";
import { DelegateManager, type DelegateRequest } from "../manager.ts";
import type { ChildSession } from "../runtime.ts";
import { deferredPromise } from "./eventually.ts";

export const context = {
	cwd: process.cwd(),
	model: { provider: "test", id: "model" },
	modelRegistry: {
		find: () => undefined,
		hasConfiguredAuth: () => true,
	},
} as unknown as ExtensionContext;

export class FakeChild {
	readonly model = { provider: "test", id: "child" };
	readonly prompts: string[] = [];
	readonly steering: string[] = [];
	readonly steeringStarted: string[] = [];
	isStreaming = false;
	disposed = false;
	abortLeavesRunning: boolean = false;
	abortGate?: Deferred.Deferred<void>;
	steerGate?: Deferred.Deferred<void>;
	private listeners = new Set<(event: AgentSessionEvent) => void>();
	private promptCompletion?: Deferred.Deferred<void, Error>;

	prompt(text: string) {
		this.prompts.push(text);
		this.isStreaming = true;
		this.promptCompletion = Deferred.makeUnsafe<void, Error>();
		return deferredPromise(this.promptCompletion);
	}

	steer(text: string) {
		this.steeringStarted.push(text);
		return (
			this.steerGate ? deferredPromise(this.steerGate) : Promise.resolve()
		).then(() => this.steering.push(text));
	}

	abortCalls = 0;

	abort() {
		this.abortCalls++;
		return (
			this.abortGate ? deferredPromise(this.abortGate) : Promise.resolve()
		).then(() => {
			if (!this.abortLeavesRunning) this.completePrompt();
		});
	}

	disposeNow() {
		this.disposed = true;
		this.completePrompt();
	}

	dispose() {
		this.disposeNow();
	}

	rejectPrompt(error: Error) {
		this.completePrompt(error);
	}

	emitAssistantStart() {
		this.emit({
			type: "message_start",
			message: { role: "assistant", content: [] },
		} as unknown as AgentSessionEvent);
	}

	emitAssistant(
		output: string,
		totalTokens: number,
		stopReason: "stop" | "toolUse" = "toolUse",
	) {
		this.emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: output }],
				stopReason,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens,
					cost: { total: 0.001 },
				},
			},
		} as AgentSessionEvent);
	}

	finishWithoutResponse() {
		this.completePrompt();
	}

	finish(output: string, totalTokens = 15) {
		this.emitAssistant(output, totalTokens, "stop");
		this.completePrompt();
	}

	subscribe(listener: (event: AgentSessionEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentSessionEvent) {
		for (const listener of this.listeners) listener(event);
	}

	private completePrompt(error?: Error) {
		this.isStreaming = false;
		if (this.promptCompletion) {
			Effect.runSync(
				error
					? Deferred.fail(this.promptCompletion, error)
					: Deferred.succeed(this.promptCompletion, undefined),
			);
			this.promptCompletion = undefined;
		}
	}
}

export function harness(
	onSettled?: (snapshot: DelegateSnapshot) => void,
	beforeShutdown?: (child: FakeChild) => Effect.Effect<void>,
) {
	const sessions: FakeChild[] = [];
	const requests: DelegateRequest[] = [];
	const manager = new DelegateManager({
		onSettled,
		createSession(request) {
			requests.push(request);
			const child = new FakeChild();
			setImmediate(() => sessions.push(child));
			return Promise.resolve(child as unknown as ChildSession);
		},
		shutdownSession(child) {
			const fake = child as unknown as FakeChild;
			return Effect.runPromise(
				Effect.gen(function* () {
					if (beforeShutdown) yield* beforeShutdown(fake);
					fake.disposeNow();
				}),
			);
		},
	});
	return { manager, sessions, requests };
}
