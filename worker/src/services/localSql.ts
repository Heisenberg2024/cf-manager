import type { LocalSql } from './auditQueries';
const adapters = new WeakMap<D1Database, LocalSql>();
export function localSql(db:D1Database):LocalSql {
  let adapter=adapters.get(db);
  if(!adapter){adapter={
    async all<T>(sql:string,params:unknown[]=[]){return (await db.prepare(sql).bind(...params).all<T>()).results;},
    async run(sql,params=[]){await db.prepare(sql).bind(...params).run();},
    async batch(statements){await db.batch(statements.map(s=>db.prepare(s.sql).bind(...(s.params??[]))));},
  };adapters.set(db,adapter);}return adapter;
}
