import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
} from "@earendil-works/pi-coding-agent";

type SDKEvents = {
	[Event in ExtensionEvent as Event["type"]]: Event;
};

type Handlers = {
	[Name in keyof SDKEvents]?: ExtensionHandler<SDKEvents[Name], unknown>;
};

export function extensionTestAdapter() {
	const handlers: Handlers = {};

	const registration = {
		on<Name extends keyof SDKEvents>(name: Name, handler: Handlers[Name]) {
			handlers[name] = handler;
		},
	};

	return {
		api: unsafeFixture<ExtensionAPI>(registration),
		emit<Name extends keyof SDKEvents>(
			name: Name,
			event: SDKEvents[Name],
			context: ExtensionContext,
		) {
			const registered = handlers[name];

			if (!registered)
				return Promise.reject(new Error(`No handler registered for ${name}`));

			return Promise.resolve(registered(event, context));
		},
	};
}

/**
 * Marks intentionally partial SDK fixtures at the test boundary. Production code
 * never receives these values; each test supplies the fields its handler reads.
 */
export function unsafeFixture<T>(value: Partial<T>): T {
	// SAFETY: Tests supply every field exercised by the handler; omitted SDK fields are never read.
	return value as T;
}
