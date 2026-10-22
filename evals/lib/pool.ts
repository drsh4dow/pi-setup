/**
 * Runs `task` on every item, at most `concurrency` at a time, and resolves once every task has
 * finished. Each worker takes the next item when its current task ends.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  }

  let next = 0;

  const worker = async (): Promise<void> => {
    const index = next;

    if (index >= items.length) return;

    next += 1;
    await task(items[index]);
    await worker();
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}
