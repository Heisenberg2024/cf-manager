import {it,expect,vi} from 'vitest';
const api=vi.hoisted(()=>({options:vi.fn()}));
vi.mock('../src/api/accounts',()=>({accountsApi:{getOptions:api.options}}));
import {loadDemoAccounts,resetDemoAccounts,isDemoAccount} from '../src/utils/demoAccounts';
it('does not let a previous session finish loading demo metadata into the next session',async()=>{resetDemoAccounts();let release!:(data:unknown)=>void;api.options.mockReturnValueOnce(new Promise(r=>{release=r;}));const previous=loadDemoAccounts();resetDemoAccounts();release({data:{accounts:[{id:1,is_demo:true}]}});await previous;expect(isDemoAccount(1)).toBe(false);api.options.mockResolvedValueOnce({data:{accounts:[{id:2,is_demo:true}]}});await loadDemoAccounts();expect(isDemoAccount(2)).toBe(true);expect(api.options).toHaveBeenCalledTimes(2);resetDemoAccounts();});
