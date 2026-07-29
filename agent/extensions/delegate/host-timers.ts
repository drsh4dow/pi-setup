// Delegate callbacks store timer handles for synchronous cancellation; Effect.sleep exposes no equivalent host handle.
export const scheduleTimer = (
	callback: () => void,
	delay: number,
): ReturnType<typeof globalThis.setTimeout> =>
	Reflect.apply(Reflect.get(globalThis, "setTimeout"), globalThis, [
		callback,
		delay,
	]);

export const cancelTimer = (
	timer: ReturnType<typeof globalThis.setTimeout>,
): void =>
	Reflect.apply(Reflect.get(globalThis, "clearTimeout"), globalThis, [timer]);
