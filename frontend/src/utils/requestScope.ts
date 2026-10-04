/** Owns both result assignment and loading completion for a resource in the current context. */
export function createRequestScope(defaultContext: () => string = () => '') {
  let revision = 0;
  const identities = new Map<string, number>();
  function invalidate() { revision++; }
  function begin(channel: string, context = defaultContext) {
    const identity = (identities.get(channel) || 0) + 1;
    identities.set(channel, identity);
    const startedRevision = revision;
    const startedContext = context();
    return { current: () => startedRevision === revision && identities.get(channel) === identity && context() === startedContext };
  }
  return { begin, invalidate };
}
