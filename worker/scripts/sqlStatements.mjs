// Split migration SQL without breaking quoted semicolons, comments, or BEGIN...END trigger bodies.
export function sqlStatements(source){
 const result=[];let part='',word='',quote='',lineComment=false,blockComment=false,trigger=false,depth=0;
 const flushWord=()=>{const token=word.toUpperCase();word='';if(token==='TRIGGER'&&/^\s*CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER\b/i.test(part))trigger=true;if(trigger){if(token==='BEGIN'||token==='CASE')depth++;else if(token==='END')depth--;}};
 for(let i=0;i<source.length;i++){
  const c=source[i],next=source[i+1];
  if(lineComment){if(c==='\n'){lineComment=false;part+='\n';}continue;}
  if(blockComment){if(c==='*'&&next==='/'){blockComment=false;i++;part+=' ';}continue;}
  if(quote){part+=c;if(c===quote){if(next===quote&&quote!==']'){part+=next;i++;}else quote='';}continue;}
  if(c==='-'&&next==='-'){flushWord();lineComment=true;i++;part+=' ';continue;}
  if(c==='/'&&next==='*'){flushWord();blockComment=true;i++;part+=' ';continue;}
  if(c==="'"||c==='"'||c==='`'||c==='['){flushWord();quote=c==='['?']':c;part+=c;continue;}
  if(/[A-Za-z_]/.test(c)){word+=c;part+=c;continue;}
  flushWord();
  if(c===';'&&(!trigger||depth===0)){if(part.trim())result.push(part.trim());part='';trigger=false;depth=0;}
  else part+=c;
 }
 flushWord();if(quote||blockComment||trigger&&depth!==0)throw Error('Unterminated migration SQL');if(part.trim())result.push(part.trim());return result;
}
