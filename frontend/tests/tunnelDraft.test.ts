import { describe, expect, it } from 'vitest';
import { tunnelDraft, tunnelDirty, tunnelCanSave } from '../src/utils/tunnelDraft';
import { fullConfig } from '../../shared/tests/tunnelsRules.fixture';
import { validateConfig } from '../src/shared/tunnelConfig';
describe('Tunnel drafts preserve remote state', () => {
  const baseline = () => ({ config: fullConfig(), fetchedAt: 1000, version: 5 });
  const entries = () => fullConfig().ingress.map(original => ({ original, hostname: original.hostname || '', path: original.path || '', service: original.service }));
  it('untouched full configuration is clean, including path-only and custom services', () => { const draft = tunnelDraft(baseline(), entries()); expect(draft).toEqual(fullConfig()); expect(tunnelDirty(baseline(), draft)).toBe(false); });
  it('changes only edited service and preserves immutable baseline/advanced fields', () => { const e = entries(); e[0].service = 'hello_world'; const b = baseline(); const draft = tunnelDraft(b, e)!; expect(tunnelDirty(b, draft)).toBe(true); expect(b.config).toEqual(fullConfig()); expect(draft.ingress[0].originRequest).toEqual(fullConfig().ingress[0].originRequest); });
  it('retains a hostname even without a matching Zone list', () => { expect(tunnelDraft(baseline(), entries())?.ingress[0].hostname).toBe('app.example.test'); });
  it('null config cannot become default writable configuration', () => { expect(tunnelDraft(null, [])).toBeNull(); expect(tunnelDirty(null, null)).toBe(false); });
  it('disabled save for failed reads, expiry, clean state and duplicate submission', () => { const ready = { baseline: baseline(), dirty: true, blocked: false, loading: false, saving: false, now: 2000 }; expect(tunnelCanSave(ready)).toBe(true); for (const patch of [{ baseline: null }, { dirty: false }, { blocked: true }, { loading: true }, { saving: true }, { now: 31001 }]) expect(tunnelCanSave({ ...ready, ...patch })).toBe(false); });
  it('reordering hostname/path rules does not rewrite their fields', () => { const e = entries(); [e[0], e[1]] = [e[1], e[0]]; const d = tunnelDraft(baseline(), e)!; validateConfig(d); expect(d.ingress[1]).toEqual(fullConfig().ingress[0]); expect(d.ingress.at(-1)).toEqual(fullConfig().ingress.at(-1)); });
  it('50/100 ingress visual round trip preserves all unknown fields and final catch-all', () => { for (const count of [50, 100]) { const b = baseline(); b.config.ingress = [...Array.from({ length: count }, (_, i) => ({ ...fullConfig().ingress[0], hostname: `h${i}.example.test` })), fullConfig().ingress.at(-1)!]; const d = tunnelDraft(b, b.config.ingress.map(original => ({ original, hostname: original.hostname || '', path: original.path || '', service: original.service }))); expect(d).toEqual(b.config); } });
});
