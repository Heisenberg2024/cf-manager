import { describe, it, expect } from 'vitest';
import { dnsAccountLabel } from '../src/utils/dnsAccountLabel';
describe('DNS credential and Account identities', () => {
  it('uses the exact Credential management name instead of the Account credential label', () => {
    const account = { id: 1, name: 'Production', credential_id: 10, credential_name: "abc@mail.com's Account" };
    const names = new Map([[10, 'abc@mail.com'], [20, "Custom's Account"]]);
    expect(dnsAccountLabel(account, names, 'Credential')).toBe('Production｜abc@mail.com');
    expect(dnsAccountLabel({ ...account, credential_id: 20 }, names, 'Credential')).toBe("Production｜Custom's Account");
  });
  it('uses a neutral credential placeholder if the authoritative name is unavailable', () => {
    expect(dnsAccountLabel({ id: 1, name: 'Production', credential_id: 10, credential_name: "abc@mail.com's Account" }, new Map(), 'Credential')).toBe('Production｜Credential #10');
  });
});
