import { canonical, editIngress, type Ingress, type TunnelConfig, type TunnelSnapshot } from '../shared/tunnelConfig';
export interface IngressDraft { original: Ingress; hostname: string; path: string; service: string }
export function tunnelDraft(baseline: TunnelSnapshot | null, entries: IngressDraft[]): TunnelConfig | null {
  return baseline ? { ...baseline.config, ingress: entries.map(entry => editIngress(entry.original, entry)) } : null;
}
export function tunnelDirty(baseline: TunnelSnapshot | null, draft: TunnelConfig | null): boolean { return !!baseline && canonical(draft) !== canonical(baseline.config); }
export function tunnelCanSave(input: { baseline: TunnelSnapshot | null; dirty: boolean; blocked: boolean; loading: boolean; saving: boolean; now: number }): boolean {
  return !!input.baseline && input.dirty && !input.blocked && !input.loading && !input.saving && input.now - input.baseline.fetchedAt <= 30000;
}
