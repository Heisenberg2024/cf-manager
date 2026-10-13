import type {TestHarness} from './dnsBatch.contract';
import type * as Policy from '../d1SqlPolicy';
import type {D1Resources} from '../d1Resources';
import type {BoundReadCache} from '../resourceCache';
import type {ZoneDirectory} from '../zoneDirectory';
import type {CfRequest} from '../accountDiscovery';
type Implementation={authorizeSql:typeof Policy.authorizeSql;classifySql:typeof Policy.classifySql;boundQueryResult:typeof Policy.boundQueryResult;D1Resources:new(...args:ConstructorParameters<typeof D1Resources>)=>Pick<D1Resources,'execute'|'tables'|'schema'|'databases'|'tablePage'|'invalidate'>;BoundReadCache:new(...args:ConstructorParameters<typeof BoundReadCache>)=>Pick<BoundReadCache,'read'|'invalidate'|'uncached'>;ZoneDirectory:new(...args:ConstructorParameters<typeof ZoneDirectory>)=>{scheduler:Pick<import('../readScheduler').ReadScheduler,'run'>}};
export const readSqlCases=["SELECT '; DELETE FROM users'",'-- comment\nSELECT * FROM users','/* INSERT */ SELECT "delete" FROM users','WITH c AS (SELECT 1) SELECT * FROM c','WITH RECURSIVE c(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM c WHERE x<5) SELECT * FROM c','WITH c AS NOT MATERIALIZED (SELECT 1) SELECT * FROM c','EXPLAIN QUERY PLAN SELECT * FROM users','PRAGMA table_info("users")','PRAGMA main.table_list','SELECT * FROM pragma_table_info(\'users\')',"SELECT '(' AS value",'VALUES(1)'];
export const writeSqlCases=['INSERT INTO users VALUES(1)', '-- SELECT\nDELETE FROM users','/* read */ UPDATE users SET id=2','WITH c AS (SELECT 1) DELETE FROM users','WITH c AS (SELECT 1), d AS (SELECT 2) INSERT INTO users SELECT * FROM c','PRAGMA foreign_keys=OFF','PRAGMA defer_foreign_keys(1)','PRAGMA optimize','CREATE TABLE test(id INTEGER)','ALTER TABLE users ADD COLUMN value TEXT','DROP TABLE users'];
export const unsupportedSqlCases=['SELECT 1; DELETE FROM users','SELECT 1; SELECT 2','PRAGMA writable_schema=ON','PRAGMA table_info=1','EXPLAIN PRAGMA foreign_keys=OFF','EXPLAIN DELETE FROM users','ATTACH DATABASE \'file\' AS other','BEGIN','COMMIT','SELECT load_extension(\'x\')','SELECT "writefile"(\'x\',\'y\')','SELECT * FROM pragma_optimize()','WITH c AS (DELETE FROM users) SELECT * FROM c','/* unclosed','SELECT \'unterminated','SELECT (1'];
const account={id:1,name:'fixture',account_id:'cf-a',credential_id:10,api_token:'synthetic',is_active:1,enabled_features:'storage'};
export function d1ResourcesContract(label:string,implementation:Implementation,harness:TestHarness){
 const {describe,it,expect}=harness,{authorizeSql,classifySql,boundQueryResult,D1Resources,BoundReadCache,ZoneDirectory}=implementation;
 const runtime=()=>new D1Resources(new BoundReadCache(new ZoneDirectory(),undefined,30000,30000));
 describe(`${label} D1 SQL boundaries`,()=>{
  for(const sql of readSqlCases)it(`reads ${sql}`,()=>{expect(authorizeSql(sql,false,true).readOnly).toBe(true);});
  for(const sql of writeSqlCases)it(`requires exact authorization for ${sql}`,()=>{for(const allow of [false,undefined,'true',1])expect(()=>authorizeSql(sql,allow)).toThrow();expect(authorizeSql(sql,true).readOnly).toBe(false);expect(()=>authorizeSql(sql,true,true)).toThrow('read-only');});
  for(const sql of unsupportedSqlCases)it(`conservatively refuses ${sql}`,()=>{expect(()=>classifySql(sql)).toThrow();expect(()=>authorizeSql(sql,true)).toThrow();});
  it('bounds query output and flags truncation instead of silently rendering unlimited rows',()=>{const result=boundQueryResult({result:[{results:Array.from({length:10000},(_,i)=>({i})),meta:{rows_read:10000}}]});expect(result.results).toHaveLength(1000);expect(result.meta.result_truncated).toBe(true);expect(()=>boundQueryResult({result:[{success:false,results:[]}]})).toThrow();});
  it('caches metadata but never query results, and validates live database ownership before writes',async()=>{
   const value=runtime();const calls:Array<{path:string;init:any}>=[];const request:CfRequest=async(path,init)=>{calls.push({path,init});if(!init?.method)return {result:{uuid:path.endsWith('wrong')?'different':'db-a'}};return {result:[{success:true,results:[{name:'users'}],meta:{}}]};};
   await value.tables(account,request,'db-a');await value.tables(account,request,'db-a');expect(calls).toHaveLength(1);
   await value.execute(account,request,'db-a',{sql:'SELECT 1'});await value.execute(account,request,'db-a',{sql:'SELECT 1'});expect(calls).toHaveLength(3);
   await expect(value.execute(account,request,'wrong',{sql:'DELETE FROM users',allowWrite:true})).rejects.toThrow('does not belong');expect(calls.filter(c=>c.path.includes('wrong')&&c.init?.method)).toHaveLength(0);
   await value.execute(account,request,'db-a',{sql:'ALTER TABLE users ADD COLUMN v TEXT',allowWrite:true});await value.tables(account,request,'db-a');expect(calls).toHaveLength(7);
   expect(calls.filter(c=>c.init?.method).every(c=>c.init.retry===false)).toBe(true);
  });
  it('does not retry unknown SQL results and removes SQL/parameter content from diagnostic errors',async()=>{
   let calls=0;const value=runtime(),request:CfRequest=async(_path,init)=>{calls++;if(!init?.method)return {result:{uuid:'db'}};throw Object.assign(Error('sensitive SQL secret value'),{statusCode:503});};
   await expect(value.execute(account,request,'db',{sql:"INSERT INTO users VALUES('secret')",allowWrite:true})).rejects.toThrow('unknown');expect(calls).toBe(2);
  });
  it('rejects unsafe parameters and absent write grants before contacting Cloudflare',async()=>{
   let calls=0;const request:CfRequest=async()=>{calls++;return {};},value=runtime();await expect(value.execute(account,request,'db',{sql:'DELETE FROM users',allowWrite:'true'})).rejects.toThrow();await expect(value.execute(account,request,'db',{sql:'SELECT ?',params:[{secret:'value'}]})).rejects.toThrow();expect(calls).toBe(0);
  });
 });
}
