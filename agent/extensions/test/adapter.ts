import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

type TestEvents = {
	agent_start: AgentStartEvent;
	agent_end: AgentEndEvent;
	message_start: MessageStartEvent;
	message_update: MessageUpdateEvent;
	message_end: MessageEndEvent;
	session_start: SessionStartEvent;
	model_select: Extract<ExtensionEvent, { type: "model_select" }>;
	session_shutdown: SessionShutdownEvent;
};

type TestEventName = keyof TestEvents;
type Handlers = Partial<Record<TestEventName, unknown>>;

export interface ExtensionTestAdapter {
	readonly api: ExtensionAPI;
	emit<Name extends TestEventName>(
		name: Name,
		event: TestEvents[Name],
		context: ExtensionContext,
	): Promise<void>;
}

export function extensionTestAdapter(): ExtensionTestAdapter {
	const handlers: Handlers = {};
	const registration = {
		on<Name extends TestEventName>(
			name: Name,
			handler: ExtensionHandler<TestEvents[Name]>,
		) {
			handlers[name] = handler;
		},
	};

	return {
		api: unsafeFixture<ExtensionAPI>(registration),
		emit(name, event, context) {
			const registered = handlers[name];
			if (!registered)
				return Promise.reject(new Error(`No handler registered for ${name}`));
			const handler =
				unsafeFixture<ExtensionHandler<TestEvents[typeof name]>>(registered);
			return Promise.resolve(handler(event, context)).then(() => undefined);
		},
	};
}

/**
 * Marks intentionally partial SDK fixtures at the test boundary. Production code
 * never receives these values; each test supplies the fields its handler reads.
 */
export function unsafeFixture<T>(value: unknown): T {
	return value as T;
}
