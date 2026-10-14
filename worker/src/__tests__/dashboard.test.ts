import { describe,it,expect } from 'vitest';
import * as audit from '../services/auditQueries';
import * as data from '../services/dashboardData';
import { dashboardContract } from '../../../shared/tests/dashboard.contract';
import { dashboardDb } from '../../../shared/tests/dashboard.fixture.mjs';
import { localSql } from '../services/localSql';
dashboardContract('Worker dashboard/audit SQL',audit,data,{describe,it,expect});
it('D1 SQL adapter matches SQLite query semantics',async()=>{const f=dashboardDb();f.accounts(20);f.logs(100);const db=localSql(f.d1 as unknown as D1Database);expect((await data.dashboardOverview(db,{})).counts.bindings).toBe(20);expect((await audit.auditPage(db,{limit:20})).items).toHaveLength(20);f.sqlite.close();});
