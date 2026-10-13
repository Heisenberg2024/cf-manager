/** Per-drawer, per-resource memory cache. Never persists configuration or Secret input. */
export function createDrawerReads(identity: () => string, onError: (message: string) => void = () => {}) {
  const cache = new Map<string, { at: number; value: any }>();
  const flights = new Map<string, Promise<any>>();
  const controllers = new Map<string, AbortController>();
  const revisions = new Map<string, number>();
  let generation = 0;
  function sanitize(value: any): any {
    if (value?.config && 'data' in value) return { data: sanitize(value.data) };
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, v]) => [key, sanitize(v)]));
    if ((typeof next.type === 'string' && next.type.startsWith('secret_')) || next.secret === true) { delete next.value; delete next.text; delete next.key_base64; }
    return next;
  }
  async function read<T>(resource: string, task: (signal: AbortSignal) => Promise<T>, force = false): Promise<T> {
    const context = identity(), key = `${context}:${resource}`, session = generation;
    if (force) { cache.delete(key); controllers.get(key)?.abort(); revisions.set(key, (revisions.get(key) || 0) + 1); flights.delete(key); }
    const revision = revisions.get(key) || 0;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 30000) return structuredClone(cached.value);
    const existing = flights.get(key); if (existing) return structuredClone(await existing);
    const controller = new AbortController(); controllers.set(key, controller);
    const promise = (async () => {
      try {
        const value = sanitize(await task(controller.signal));
        if (controller.signal.aborted || context !== identity() || session !== generation || revision !== (revisions.get(key) || 0)) throw new DOMException('Drawer changed', 'AbortError');
        cache.delete(key); cache.set(key, { value, at: Date.now() });
        while (cache.size > 30) cache.delete(cache.keys().next().value!);
        return value;
      } catch (error: any) { if (!controller.signal.aborted && context === identity() && session === generation) onError(error.errorMessage || error.message); throw error; }
      finally { if (controllers.get(key) === controller) { controllers.delete(key); flights.delete(key); } }
    })();
    flights.set(key, promise); return structuredClone(await promise);
  }
  function cancel(clear = false) { generation++; for (const controller of controllers.values()) controller.abort(); controllers.clear(); flights.clear(); if (clear) { cache.clear(); revisions.clear(); } }
  return { read, cancel };
}
