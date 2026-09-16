/** Run async work over items with bounded concurrency; results preserve input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
