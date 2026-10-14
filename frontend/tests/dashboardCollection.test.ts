import {describe,it,expect} from 'vitest';
import {confirmedResourceKeys,collectionKey} from '../src/utils/dashboardCollection';
import type {DashboardAccount,Metric} from '../src/shared/dashboardData';
const account=(id:number,cf='same')=>({id,account_id:cf} as DashboardAccount);
const metric=(state='ready',last=1000)=>({metric:'workers',state,complete:true,lastSuccessAt:last} as Metric);
describe('Dashboard collection coverage',()=>{
 it('never treats unknown and partial data as a complete account',()=>{expect(confirmedResourceKeys([account(1)],[{accountId:1,metrics:[metric('unknown'),metric('partial')]}],1000).size).toBe(0);});
 it('deduplicates different credentials for one real CF Account',()=>{const keys=confirmedResourceKeys([account(1),account(2)],[{accountId:1,metrics:[metric()]},{accountId:2,metrics:[metric()]}],1000);expect(keys.size).toBe(1);expect(keys.has(collectionKey(account(2),'workers'))).toBe(true);});
 it('retains isolation between different Accounts, deleted bindings and expired observations',()=>{expect(confirmedResourceKeys([account(1,'a'),account(2,'b')],[{accountId:1,metrics:[metric()]},{accountId:2,metrics:[metric()]}],1000).size).toBe(2);expect(confirmedResourceKeys([], [{accountId:1,metrics:[metric()]}],1000).size).toBe(0);expect(confirmedResourceKeys([account(1)],[{accountId:1,metrics:[metric()]}],86402000).size).toBe(0);});
});
