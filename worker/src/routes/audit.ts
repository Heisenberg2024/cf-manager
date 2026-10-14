import { Hono } from 'hono';
import type { Env } from '../types';
import { localSql } from '../services/localSql';
import { auditPage, auditStats } from '../services/auditQueries';
const router=new Hono<{Bindings:Env}>();
router.use('*',async(c,next)=>{await next();c.header('Cache-Control','no-store');});
router.get('/page',async c=>c.json(await auditPage(localSql(c.env.DB),c.req.query())));
router.get('/stats',async c=>c.json({success:true,data:await auditStats(localSql(c.env.DB),c.req.query())}));
export default router;
