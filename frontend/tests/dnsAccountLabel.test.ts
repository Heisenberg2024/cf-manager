import { describe, it, expect } from 'vitest';
import { dnsAccountLabel } from '../src/utils/dnsAccountLabel';
describe('DNS credential and Account identities', () => {
  it('distinguishes identical Account IDs and names under credentials with duplicate names', () => {
    const account = { id: 1, name: 'Production', account_id: 'a'.repeat(32), credential_id: 10, credential_name: 'Shared token' };
    expect(dnsAccountLabel(account, 'Credential')).toContain('Shared token #10');
    expect(dnsAccountLabel(account, 'Credential')).not.toBe(dnsAccountLabel({ ...account, id: 2, credential_id: 20 }, 'Credential'));
    expect(dnsAccountLabel(account, 'Credential')).not.toBe(dnsAccountLabel({ ...account, id: 3, account_id: 'b'.repeat(32) }, 'Credential'));
  });
});
