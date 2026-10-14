export function requestedAccountId(search=window.location.search):number|undefined {
 const value=new URLSearchParams(search).get('accountId');if(!value||!/^\d+$/.test(value))return;
 const id=Number(value);return Number.isSafeInteger(id)&&id>0?id:undefined;
}
