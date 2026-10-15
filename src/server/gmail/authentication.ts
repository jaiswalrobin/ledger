import { senderDomain } from "../../ingestion/ats.ts";

/** Parse Authentication-Results without interpreting comments or quoted reasons as results.
 * Trust is limited to Gmail's receiving authserv-id; it relies on Gmail stripping forged local
 * results at its boundary (RFC 8601 section 5), not on the header's text authenticating itself. */
function removeComments(value: string): string | null {
  let depth=0,quoted=false,result="";
  for(let i=0;i<value.length;i++){
    const c=value[i]!;
    if(c==="\\"&&(depth||quoted)){if(++i>=value.length)return null;if(!depth)result+=c+value[i];continue;}
    if(!depth&&c==='"'){quoted=!quoted;result+=c;continue;}
    if(!quoted&&c==='('){if(++depth>10)return null;if(depth===1)result+=' ';continue;}
    if(!quoted&&c===')'){if(!depth)return null;depth--;continue;}
    if(!depth)result+=c;
  }
  return depth||quoted?null:result;
}

function clauses(value:string):string[]|null{
  const result:string[]=[];let start=0,quoted=false;
  for(let i=0;i<value.length;i++){
    if(quoted&&value[i]==='\\'){i++;continue;}
    if(value[i]==='"')quoted=!quoted;
    if(value[i]===';'&&!quoted){result.push(value.slice(start,i));start=i+1;}
  }
  if(quoted)return null;
  result.push(value.slice(start));return result;
}

function properties(value:string):Map<string,string>|null{
  const result=new Map<string,string>();let rest=value.trim();
  while(rest){
    const key=/^(reason|[a-z][a-z0-9_-]*\s*\.\s*[a-z][a-z0-9_-]*)\s*=\s*/i.exec(rest);
    if(!key)return null;
    rest=rest.slice(key[0].length);
    let parsed="",end=0;
    if(rest.startsWith('"')){
      end=1;
      while(end<rest.length&&rest[end]!=='"'){
        if(rest[end]==='\\'&&++end>=rest.length)return null;
        parsed+=rest[end++];
      }
      if(rest[end]!=='"')return null;end++;
      if(end<rest.length&&!/\s/.test(rest[end]!))return null;
    }else{
      const token=/^\S+/.exec(rest);if(!token)return null;
      parsed=token[0];end=parsed.length;
    }
    const name=key[1]!.replace(/\s/g,"").toLowerCase();
    if(result.has(name))return null;
    result.set(name,parsed);rest=rest.slice(end).trim();
  }
  return result;
}

export function authenticatedGmailDomain(headers:readonly {name:string;value:string}[]):string|null{
  const values=headers.filter(h=>h.name.toLowerCase()==="authentication-results").map(h=>h.value);
  if(values.length>20)return null;
  const results:{pass:boolean;domain:string|null}[]=[];
  for(const raw of values){
    if(raw.length>4096)return null;
    const clean=removeComments(raw),parts=clean===null?null:clauses(clean);
    if(!parts){if(/\bmx\.google\.com\b/i.test(raw))return null;continue;}
    const server=parts.shift()!.trim().replace(/^"([^"]+)"/,"$1");
    if(/^mx\.google\.com\s+\d+$/i.test(server)&&!/^mx\.google\.com\s+1$/i.test(server))return null;
    if(!/^mx\.google\.com(?:\s+1)?$/i.test(server))continue;
    for(const part of parts){
      if(/^\s*none\s*$/i.test(part))continue;
      const method=/^\s*([a-z][a-z0-9_-]*)(?:\s*\/\s*\d+)?\s*=\s*([a-z][a-z0-9_-]*)\b/i.exec(part);
      if(!method)return null;
      if(method[1]!.toLowerCase()!=="dmarc")continue;
      const props=properties(part.slice(method[0].length));if(!props)return null;
      const domain=props.get("header.from")?.toLowerCase().replace(/\.$/,"")??null;
      results.push({pass:method[2]!.toLowerCase()==="pass",domain});
    }
  }
  if(!results.length||results.some(result=>!result.pass||!result.domain))return null;
  const domains=new Set(results.map(result=>result.domain));
  return domains.size===1?[...domains][0]!:null;
}

/** Whether Gmail authenticated the sender: exactly one From header, whose domain passed DMARC at Gmail. */
export function senderAuthenticated(headers: readonly { name: string; value: string }[]): boolean {
  const from = headers.filter((h) => h.name.toLowerCase() === "from");
  if (from.length !== 1) return false;
  // The address, not an "@" inside a display name such as "jobs@acme via Greenhouse".
  const domain = senderDomain(from[0]!.value);
  return !!domain && domain === authenticatedGmailDomain(headers);
}
