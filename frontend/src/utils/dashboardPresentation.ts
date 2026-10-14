import type {Metric,Attention} from '../shared/dashboardData';
/** Sum only known entities. A missing product or incomplete account coverage is a lower bound. */
export function inventoryTotal(metrics:Array<Metric|undefined>) {
 const known=metrics.filter((m):m is Metric=>!!m&&m.value!==null);
 return {value:known.length?known.reduce((sum,m)=>sum+m.value!,0):null,partial:known.length!==metrics.length||known.some(m=>!m.complete)};
}
export function entityDistribution(metrics:Metric[]) {
 const known=metrics.filter(m=>m.value!==null),total=known.reduce((sum,m)=>sum+m.value!,0);
 return metrics.map(m=>({...m,share:m.value===null?null:total?m.value/total:0}));
}
/** Current actionable failures precede historical audit errors at the same severity. */
export function attentionPriority(item:Attention) {
 const severity={critical:0,warning:1,info:2}[item.severity];
 const kind:Record<string,number>={unknownWrite:0,accountAccess:1,credential:2,resourceRead:0,quota:1,tunnelHealth:1,zonePending:2,catalog:3,recentAuditFailure:4};
 return severity*10+(kind[item.kind]??5);
}
