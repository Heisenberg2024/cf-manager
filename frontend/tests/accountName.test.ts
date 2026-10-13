import {describe,it,expect} from 'vitest';
import {normalizeAccountName,displayAccount} from '../src/shared/accountName';
import {dnsAccountLabel} from '../src/utils/dnsAccountLabel';
describe('Cloudflare generated Account suffix',()=>{
 it('strips the generated phrase while retaining other names and real credential labels',()=>{expect(normalizeAccountName("alice's Account")).toBe('alice');expect(normalizeAccountName('Alice’s Account')).toBe('Alice');expect(normalizeAccountName('Production')).toBe('Production');expect(normalizeAccountName("Alice's Accounting")).toBe("Alice's Accounting");expect(dnsAccountLabel({id:1,name:"alice's Account",credential_id:10},new Map([[10,"Credential's Account"]]),'Credential')).toBe("alice｜Credential's Account");});
 it('does not mutate identity or the source record',()=>{const row={id:1,credential_id:10,account_id:'real',name:"alice's Account"};expect(displayAccount(row)).toEqual({...row,name:'alice'});expect(row.name).toBe("alice's Account");});
});
