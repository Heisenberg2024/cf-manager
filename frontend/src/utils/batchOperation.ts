export interface BatchResult<T, R> { item: T; success: boolean; result?: R; error?: string }
export async function runBatch<T, R>(items: T[], operation: (item: T) => Promise<R>, onProgress: (completed: number) => void = () => {}, concurrency = 3): Promise<Array<BatchResult<T, R>>> {
  const results = new Array<BatchResult<T, R>>(items.length);
  let next = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, Math.min(5, concurrency))) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      try { results[index] = { item, success: true, result: await operation(item) }; }
      catch (error) { const e = error as { errorMessage?: string; message?: string }; results[index] = { item, success: false, error: e.errorMessage || e.message || String(error) }; }
      onProgress(++completed);
    }
  }));
  return results;
}
