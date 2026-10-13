/** Remove Cloudflare's generated possessive Account label; leave credential names and identities intact. */
export function normalizeAccountName(name:string):string {
 const value=name.replace(/['’]s Account\b/gi,'').trim();return value || name;
}
export function displayAccount<T extends {name:string}>(account:T):T{return {...account,name:normalizeAccountName(account.name)};}
