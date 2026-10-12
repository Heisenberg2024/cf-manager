import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(async () => ({ id: 'created' })), edit: vi.fn(async () => ({ id: 'edited' })), client: vi.fn() }));
vi.mock('../src/services/cfFactory', () => ({ getCfClient: mocks.client, accountRequest: vi.fn() }));
vi.mock('../src/services/logger', () => ({ apiLogger: { info: vi.fn() } }));
import { createDnsRecord, updateDnsRecord } from '../src/services/dnsService';
import type { Account } from '../src/models/account';
it('cannot override a verified Zone through SDK body fields and disables hidden write retries', async () => {
  const account = { id: 1 } as Account;
  mocks.client.mockReturnValue({ dns: { records: { create: mocks.create, edit: mocks.edit } } });
  const body = { type: 'A', name: 'api.test', content: '192.0.2.1', zone_id: 'unverified-zone' };
  await createDnsRecord(account, 'verified-zone', body);
  await updateDnsRecord(account, 'verified-zone', 'record-1', body);
  expect(mocks.create).toHaveBeenCalledWith({ ...body, zone_id: 'verified-zone' });
  expect(mocks.edit).toHaveBeenCalledWith('record-1', { ...body, zone_id: 'verified-zone' });
  expect(mocks.client).toHaveBeenCalledWith(account, 0);
  await expect(updateDnsRecord(account, 'verified-zone', '../../foreign-zone/record', body)).rejects.toMatchObject({ statusCode: 400 });
  expect(mocks.client).toHaveBeenCalledTimes(2);
});
