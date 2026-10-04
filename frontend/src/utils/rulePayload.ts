export function cacheRuleParameters(cache: boolean, mode: 'respect_origin' | 'custom', ttl: number, original: Record<string, unknown> = {}) {
  const edge = original.edge_ttl && typeof original.edge_ttl === 'object' ? original.edge_ttl as Record<string, unknown> : {};
  const edge_ttl = { ...edge, mode: mode === 'custom' ? 'override_origin' : 'respect_origin', ...(mode === 'custom' ? { default: ttl } : {}) };
  if (mode !== 'custom') delete (edge_ttl as Record<string, unknown>).default;
  return { ...original, cache, edge_ttl };
}
export function headerRuleParameters(name: string, operation: 'set' | 'remove', value: string) {
  return { headers: { [name]: { operation, ...(operation === 'remove' ? {} : { value }) } } };
}
