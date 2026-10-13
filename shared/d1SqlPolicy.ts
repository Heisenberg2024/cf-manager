type Token={kind:'word'|'identifier'|'literal'|'symbol';value:string};
export interface SqlPolicy {operation:string;readOnly:boolean;schemaChange:boolean}
const reject=(message:string,code='SQL_POLICY_UNSUPPORTED')=>Object.assign(new Error(message),{statusCode:400,code});
/** SQLite lexical boundaries + a deliberately restricted statement classifier, not a general SQL parser. */
function tokenize(sql:string):Token[]{
 const tokens:Token[]=[];let i=0;
 while(i<sql.length){
  const c=sql[i]!;
  if(/\s|\uFEFF/.test(c)){i++;continue;}
  if(sql.slice(i,i+2)==='--'){const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end+1;continue;}
  if(sql.slice(i,i+2)==='/*'){const end=sql.indexOf('*/',i+2);if(end<0)throw reject('Unterminated SQL comment');i=end+2;continue;}
  if(c==="'"||c==='"'||c==='`'||c==='['){const close=c==='['?']':c;let value='',closed=false;i++;
   while(i<sql.length){if(sql[i]===close){if(close!==']'&&sql[i+1]===close){value+=close;i+=2;}else{i++;closed=true;break;}}else value+=sql[i++]!;}
   if(!closed)throw reject('Unterminated SQL quoted token');tokens.push({kind:c==="'"?'literal':'identifier',value});continue;
  }
  if(/[A-Za-z_\u0080-\uFFFF]/.test(c)){let value=c;i++;while(i<sql.length&&/[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i]!))value+=sql[i++]!;tokens.push({kind:'word',value:value.toUpperCase()});continue;}
  tokens.push({kind:'symbol',value:c});i++;
 }
 return tokens;
}
const readPragmas=new Set(['TABLE_INFO','TABLE_XINFO','TABLE_LIST','INDEX_LIST','INDEX_INFO','INDEX_XINFO','FOREIGN_KEY_LIST','DATABASE_LIST','COMPILE_OPTIONS','SCHEMA_VERSION','PAGE_COUNT','FREELIST_COUNT','QUICK_CHECK','INTEGRITY_CHECK']);
const argumentPragmas=new Set(['TABLE_INFO','TABLE_XINFO','TABLE_LIST','INDEX_LIST','INDEX_INFO','INDEX_XINFO','FOREIGN_KEY_LIST','QUICK_CHECK','INTEGRITY_CHECK']);
const writePragmas=new Set(['FOREIGN_KEYS','DEFER_FOREIGN_KEYS','RECURSIVE_TRIGGERS','OPTIMIZE']);
function closeParen(tokens:Token[],start:number){let depth=0;for(let i=start;i<tokens.length;i++){if(tokens[i]!.kind!=='symbol')continue;if(tokens[i]!.value==='(')depth++;if(tokens[i]!.value===')'&&!--depth)return i;}throw reject('Unbalanced SQL parentheses');}
function classify(tokens:Token[]):SqlPolicy {
 const first=tokens[0];if(!first||first.kind!=='word')throw reject('Cannot establish statement operation');
 if(first.value==='WITH'){
  let i=tokens[1]?.value==='RECURSIVE'?2:1;
  for(;;){if(!tokens[i]||!['word','identifier'].includes(tokens[i]!.kind))throw reject('Unsupported CTE name');i++;
   if(tokens[i]?.value==='(')i=closeParen(tokens,i)+1;
   if(tokens[i++]?.value!=='AS')throw reject('Unsupported CTE syntax');if(tokens[i]?.value==='NOT')i++;if(tokens[i]?.value==='MATERIALIZED')i++;
   if(tokens[i]?.value!=='(')throw reject('Unsupported CTE body');const end=closeParen(tokens,i);if(!classify(tokens.slice(i+1,end)).readOnly)throw reject('Only read-only CTE bodies are supported');i=end+1;
   if(tokens[i]?.value!==',')break;i++;
  }
  return classify(tokens.slice(i));
 }
 if(first.value==='EXPLAIN'){
  let i=1;if(tokens[i]?.value==='QUERY'&&tokens[i+1]?.value==='PLAN')i+=2;
  const inner=classify(tokens.slice(i));if(!inner.readOnly||inner.operation==='PRAGMA')throw reject('EXPLAIN is supported only for read queries');return {...inner,operation:'EXPLAIN'};
 }
 if(first.value==='PRAGMA'){
  let i=1;if(tokens[i+1]?.value==='.')i+=2;const name=tokens[i++]?.value.toUpperCase();if(!name)throw reject('Missing PRAGMA name');
  if(readPragmas.has(name)){
   if(i<tokens.length){if(!argumentPragmas.has(name)||tokens[i]?.value!=='('||closeParen(tokens,i)!==tokens.length-1)throw reject('Unsupported or mutating PRAGMA form');}
   return {operation:'PRAGMA',readOnly:true,schemaChange:false};
  }
  if(writePragmas.has(name))return {operation:'PRAGMA',readOnly:false,schemaChange:name==='OPTIMIZE'};
  throw reject('PRAGMA is outside the supported safe allowlist');
 }
 if(first.value==='SELECT'||first.value==='VALUES')return {operation:first.value,readOnly:true,schemaChange:false};
 if(['INSERT','UPDATE','DELETE','REPLACE','CREATE','ALTER','DROP','REINDEX','ANALYZE'].includes(first.value))return {operation:first.value,readOnly:false,schemaChange:['CREATE','ALTER','DROP','REINDEX'].includes(first.value)};
 throw reject('Statement is outside the supported SQL subset; transaction/attachment controls and multiple statements are not supported');
}
export function classifySql(sql:unknown):SqlPolicy {
 if(typeof sql!=='string'||!sql.trim()||new TextEncoder().encode(sql).length>100000||sql.includes('\0'))throw reject('SQL must contain one statement within 100000 bytes','VALIDATION_ERROR');
 const tokens=tokenize(sql);if(tokens.at(-1)?.value===';')tokens.pop();
 if(tokens.some(t=>t.kind==='symbol'&&t.value===';'))throw reject('Execute one SQL statement per confirmed request');
 let depth=0;for(const token of tokens){if(token.value==='('&&token.kind==='symbol')depth++;if(token.value===')'&&token.kind==='symbol'&&--depth<0)throw reject('Unbalanced SQL parentheses');}if(depth)throw reject('Unbalanced SQL parentheses');
 for(let i=0;i<tokens.length;i++){const token=tokens[i]!,name=token.value.toUpperCase();
  if(tokens[i+1]?.value==='('&&['word','identifier','literal'].includes(token.kind)&&(['LOAD_EXTENSION','WRITEFILE','READFILE','EVAL','FTS3_TOKENIZER'].includes(name)||(name.startsWith('PRAGMA_')&&!readPragmas.has(name.slice(7)))))throw reject('Function is outside the supported safe SQL subset');
 }
 return classify(tokens);
}
export function authorizeSql(sql:unknown,allowWrite:unknown,demo=false):SqlPolicy {
 const policy=classifySql(sql);
 if(!policy.readOnly&&demo)throw Object.assign(new Error('Demo databases are read-only'),{statusCode:403,code:'DEMO_PROTECTED'});
 if(!policy.readOnly&&allowWrite!==true)throw reject('Write SQL requires explicit allowWrite: true','WRITE_NOT_ALLOWED');
 return policy;
}
export function quoteIdentifier(name:string){if(!name||name.length>256||name.includes('\0'))throw reject('Invalid SQL identifier','VALIDATION_ERROR');return `"${name.replace(/"/g,'""')}"`;}
export function boundQueryResult(data:any){
 const result=Array.isArray(data.result)?data.result[0]:data;
 if(!result||result.success===false||!Array.isArray(result.results))throw Object.assign(new Error('D1 query response not confirmed'),{statusCode:502,code:'D1_OUTCOME_UNCERTAIN'});
 const rows:any[]=[];let bytes=0;for(const row of result.results){const size=JSON.stringify(row).length*2;if(rows.length>=1000||bytes+size>4*1024*1024)break;bytes+=size;rows.push(row);}
 return {results:rows,meta:{...result.meta,result_truncated:rows.length<result.results.length,returned_rows:rows.length}};
}
