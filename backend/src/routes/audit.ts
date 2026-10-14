import { Router } from 'express';
import { localSql } from '../services/localSql';
import { auditPage, auditStats } from '../services/auditQueries';
const router=Router();
router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
router.get('/page',async(req,res,next)=>{try{res.json(await auditPage(localSql,req.query));}catch(e){next(e);}});
router.get('/stats',async(req,res,next)=>{try{res.json({success:true,data:await auditStats(localSql,req.query)});}catch(e){next(e);}});
export default router;
