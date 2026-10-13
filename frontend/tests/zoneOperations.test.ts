import { describe, it, expect, vi } from 'vitest';
import { zoneOperationRows, runZoneOperations, settingsOperationResult } from '../src/utils/zoneOperations';
import type { ZoneSettingsResult } from '../src/shared/zoneSettingsEvents';

const target = (accountId: number, zoneId: string) => ({ accountId, zoneId, name: 'same.test', accountLabel: `Account ${accountId}｜Credential` });
describe('batch Zone writes', () => {
  it('captures identities, submits each actual Zone once and continues after rejected or lost receipts', async () => {
    const targets = [target(1, 'a'), target(2, 'a'), target(3, 'b'), target(4, 'c')];
    const rows = zoneOperationRows(targets);
    targets[0]!.zoneId = 'changed-after-opening';
    const submitted: string[] = [], progress = vi.fn();
    await runZoneOperations(rows, async row => {
      submitted.push(`${row.target.accountId}:${row.target.zoneId}`);
      if (row.target.zoneId === 'a') throw Object.assign(Error('Permission denied'), { response: { status: 403 } });
      if (row.target.zoneId === 'b') throw Error('Connection lost');
      row.status = 'success';
    }, progress);
    expect(submitted).toEqual(['1:a', '3:b', '4:c']);
    expect(rows.map(row => row.status)).toEqual(['failed', 'skipped', 'uncertain', 'success']);
    expect(progress).toHaveBeenLastCalledWith(4);
    // Finished result rows cannot be resubmitted from the same dialog.
    await runZoneOperations(rows, async row => { submitted.push(row.target.zoneId); }, progress);
    expect(submitted).toHaveLength(3);
  });
  it('keeps failed preflight reads out of the mutation queue and limits concurrency to three', async () => {
    const rows = zoneOperationRows(Array.from({ length: 12 }, (_, index) => target(index, String(index))));
    rows[0]!.status = 'failed';
    let active = 0, peak = 0, writes = 0;
    await runZoneOperations(rows, async row => {
      active++; writes++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--; row.status = 'success';
    }, () => {});
    expect(peak).toBe(3); expect(writes).toBe(11); expect(rows[0]!.status).toBe('failed');
  });
  it('distinguishes actual partial changes, no-op, conflict and missing confirmations', () => {
    const row = zoneOperationRows([target(1, 'a')])[0]!;
    const result: ZoneSettingsResult = { updated: ['ssl'], failed: ['always_use_https'], errors: {}, fields: { ssl: { status: 'updated', actual: 'strict' }, always_use_https: { status: 'unavailable' } }, settings: { ssl: 'strict', __meta: {} }, patchCount: 1, conflictDetection: 'non-atomic' };
    settingsOperationResult(row, result, { ssl: 'strict', always_use_https: 'on' }); expect(row.status).toBe('partial');
    result.fields.always_use_https = { status: 'uncertain' };
    settingsOperationResult(row, result, { ssl: 'strict', always_use_https: 'on' }); expect(row.status).toBe('uncertain');
    result.fields.ssl = { status: 'unchanged' };
    settingsOperationResult(row, result, { ssl: 'strict' }); expect(row.status).toBe('unchanged');
    result.fields.ssl = { status: 'conflict' };
    settingsOperationResult(row, result, { ssl: 'strict' }); expect(row.status).toBe('failed');
    settingsOperationResult(row, result, { automatic_https_rewrites: 'on' }); expect(row.status).toBe('uncertain');
  });
});
