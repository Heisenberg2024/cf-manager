import {it,expect} from 'vitest';
import {inventoryTotal,entityDistribution,attentionPriority} from '../src/utils/dashboardPresentation';
import type {Metric} from '../src/shared/dashboardData';
import type {Attention} from '../src/shared/dashboardData';
const metric=(value:number|null,complete=true)=>({value,complete} as Metric);
it('Workers success plus unknown Pages is a lower bound, never confirmed zero Pages',()=>{
 expect(inventoryTotal([metric(25),metric(null)])).toEqual({value:25,partial:true});
 expect(inventoryTotal([metric(null),undefined])).toEqual({value:null,partial:true});
 expect(inventoryTotal([metric(0),metric(0)])).toEqual({value:0,partial:false});
 expect(inventoryTotal([metric(3,false),metric(4)])).toEqual({value:7,partial:true});
});
it('entity distribution excludes unknown categories and preserves known empty resources',()=>{
 expect(entityDistribution([metric(3),metric(null),metric(1),metric(0)]).map(m=>m.share)).toEqual([.75,null,.25,0]);
 expect(entityDistribution([metric(null)])[0]?.share).toBeNull();
});
it('live read failures remain visible ahead of older audit errors',()=>{
 const items=[{kind:'recentAuditFailure',severity:'warning'},{kind:'resourceRead',severity:'warning'},{kind:'credential',severity:'critical'}] as Attention[];
 expect(items.sort((a,b)=>attentionPriority(a)-attentionPriority(b)).map(i=>i.kind)).toEqual(['credential','resourceRead','recentAuditFailure']);
});
