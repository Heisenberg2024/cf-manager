import {describe,it,expect,vi} from 'vitest';
import {d1ResourcesContract,readSqlCases} from '../../shared/tests/d1Resources.contract';
import {authorizeSql,classifySql,boundQueryResult} from '../src/services/d1SqlPolicy';
import {D1Resources} from '../src/services/d1Resources';
import {BoundReadCache} from '../src/services/resourceCache';
import {ZoneDirectory} from '../src/services/zoneDirectory';
import Database from 'better-sqlite3';
import type {CfRequest} from '../src/services/accountDiscovery';
d1ResourcesContract('Docker',{authorizeSql,classifySql,boundQueryResult,D1Resources,BoundReadCache,ZoneDirectory},{describe,it,expect,vi});
describe('D1 classification and paging against actual SQLite',()=>{
 it('corroborates the allowed read corpus with SQLite statement.readonly',()=>{const db=new Database(':memory:');db.exec('CREATE TABLE users(id INTEGER,"delete" TEXT)');try{for(const sql of readSqlCases)expect(db.prepare(sql).readonly,sql).toBe(true);}finally{db.close();}});
 for(const withoutRowid of [false,true])it(`pages 10000 rows with ${withoutRowid?'composite primary keys':'hidden rowid'}`,async()=>{
  const db=new Database(':memory:');db.exec(withoutRowid?'CREATE TABLE records(group_id TEXT,id INTEGER,value TEXT,PRIMARY KEY(group_id,id)) WITHOUT ROWID':'CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT)');
  const insert=db.prepare(withoutRowid?'INSERT INTO records VALUES(?,?,?)':'INSERT INTO records VALUES(?,?)');db.transaction(()=>{for(let i=0;i<10000;i++)insert.run(...(withoutRowid?['group',i,`v${i}`]:[i,`v${i}`]));})();
  let calls=0;const request:CfRequest=async(_path,init)=>{calls++;const body=JSON.parse(String(init?.body)),stmt=db.prepare(body.sql);return {result:[{success:true,results:stmt.all(...body.params),meta:{}}]};};
  const account={id:1,name:'fixture',account_id:'cf-a',credential_id:10,is_active:1,enabled_features:'storage'},runtime=new D1Resources(new BoundReadCache(new ZoneDirectory()));
  try{let cursor:string|undefined;const seen=new Set<number>();for(let n=0;n<100;n++){const page=await runtime.tablePage(account,request,'db','records',{limit:100,cursor});expect(page.results.length).toBe(100);for(const row of page.results)seen.add(row.id);cursor=page.meta.cursor;}expect(seen.size).toBe(10000);expect(cursor).toBeUndefined();expect(calls).toBe(103);}finally{db.close();}
 });
 it('invalidates cursors on database/schema/credential changes and safely quotes unusual names',async()=>{
  const db=new Database(':memory:');db.exec('CREATE TABLE "a /;中文"(id INTEGER PRIMARY KEY);INSERT INTO "a /;中文" VALUES(1),(2),(3)');
  const request:CfRequest=async(_path,init)=>{const body=JSON.parse(String(init?.body));return {result:[{success:true,results:db.prepare(body.sql).all(...body.params),meta:{}}]};};
  const account={id:1,name:'fixture',account_id:'cf-a',credential_id:10,is_active:1,enabled_features:'storage'},runtime=new D1Resources(new BoundReadCache(new ZoneDirectory()));
  try{const page=await runtime.tablePage(account,request,'db','a /;中文',{limit:1});await expect(runtime.tablePage({...account,credential_id:20},request,'db','a /;中文',{cursor:page.meta.cursor})).rejects.toThrow('Cursor');db.exec('ALTER TABLE "a /;中文" ADD COLUMN value TEXT');runtime.invalidate(1,'cf-a','db');await expect(runtime.tablePage(account,request,'db','a /;中文',{cursor:page.meta.cursor})).rejects.toThrow('Cursor');}finally{db.close();}
 });
});
