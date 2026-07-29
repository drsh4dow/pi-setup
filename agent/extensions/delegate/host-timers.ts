// Delegate callbacks store timer handles for synchronous cancellation; Effect.sleep exposes no equivalent host handle.
export const scheduleTimer = (
	callback: () => void,
	delay: number,
): ReturnType<typeof globalThis.setTimeout> =>
	// @effect-diagnostics-next-line globalTimers:off
	globalThis.setTimeout(callback, delay);

export const cancelTimer = (
	timer: ReturnType<typeof globalThis.setTimeout>,
): void => globalThis.clearTimeout(timer);
