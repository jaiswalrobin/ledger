import {createHash} from "node:crypto";
import type {Db} from "./db.ts";
import {companyKey,normalizedText} from "../domain/normalization.ts";
import type {ExtractedFields} from "../ingestion/source.ts";
import {atsKeyId} from "../domain/normalization.ts";
import {parse as parseDomain} from "tldts";
import {employerDomain} from "../ingestion/fields.ts";

export function messageIdKey(value:string|null):string|null {
  return value&&/^<[^\s<>]{1,512}>$/.test(value.trim())?createHash("sha256").update(value.trim()).digest("hex"):null;
}

export async function conversationAttempts(db:Db,userId:string,mailboxId:string,sender:string,refs:readonly string[],thread:string|null,fields:ExtractedFields):Promise<{attemptId:string;openingId:string;company:string;title:string;conflicting?:boolean}[]>{
  const {rows}=await db.query<{attempt_id:string;opening_id:string;company:string;title:string;ats_provider:string|null;ats_tenant:string|null;requisition_id:string|null}>(
    `SELECT DISTINCT e.attempt_id,o.id AS opening_id,c.canonical_name AS company,o.title,o.ats_provider,o.ats_tenant,o.requisition_id
     FROM source_artifacts s JOIN event_evidence ev ON ev.artifact_id=s.id AND ev.user_id=s.user_id
     JOIN application_events e ON e.id=ev.event_id AND e.user_id=ev.user_id
     JOIN application_attempts a ON a.id=e.attempt_id AND a.user_id=e.user_id
     JOIN job_openings o ON o.id=a.job_opening_id AND o.user_id=a.user_id
     JOIN companies c ON c.id=o.company_id AND c.user_id=o.user_id
     WHERE s.user_id=$1 AND s.mailbox_id=$2 AND s.sender_domain=$3 AND s.sender_verified=true
       AND e.review_state='ACCEPTED' AND (s.message_id_key=ANY($4::text[]) OR ($5::text IS NOT NULL AND s.provider_thread_id=$5))
     LIMIT 33`,[userId,mailboxId,sender,refs,thread]);
  if(rows.length>32)return rows.map(r=>({attemptId:r.attempt_id,openingId:r.opening_id,company:r.company,title:r.title}));
  const compatible = rows.filter(r=>(!fields.company||companyKey(fields.company)===companyKey(r.company))&&
    (!fields.title||normalizedText(fields.title)===normalizedText(r.title))&&
    (!fields.atsKey||(r.ats_provider&&r.ats_tenant&&r.requisition_id&&atsKeyId(fields.atsKey)===atsKeyId({provider:r.ats_provider,tenant:r.ats_tenant,requisitionId:r.requisition_id}))))
    .map(r=>({attemptId:r.attempt_id,openingId:r.opening_id,company:r.company,title:r.title}));
  return compatible.length?compatible:rows.map(r=>({attemptId:r.attempt_id,openingId:r.opening_id,company:r.company,title:r.title,conflicting:true}));
}

export async function employerOpenings(db:Db,userId:string,sender:string):Promise<{openings:{id:string;company:string;title:string}[];overflow:boolean}>{
  const domain=parseDomain(sender,{allowPrivateDomains:true,validateHostname:true});
  if(!domain.domainWithoutSuffix||!domain.domain)return {openings:[],overflow:false};
  const {rows}=await db.query<{id:string;company:string;title:string}>(
    `SELECT DISTINCT o.id,c.canonical_name AS company,o.title FROM companies c JOIN job_openings o ON o.company_id=c.id AND o.user_id=c.user_id
     JOIN application_attempts a ON a.job_opening_id=o.id AND a.user_id=o.user_id
     WHERE c.user_id=$1 AND a.outcome='PENDING' AND (c.normalized_domain=$2 OR regexp_replace(lower(c.canonical_name),'[^[:alnum:]]','','g')=$3)
     LIMIT 33`,[userId,domain.domain,domain.domainWithoutSuffix]);
  // Filtering a truncated candidate set can manufacture a unique result while an omitted
  // candidate also matches. Report overflow before any compatibility filter is applied.
  if(rows.length>32)return {openings:rows,overflow:true};
  return {openings:rows.filter(r=>employerDomain(sender,r.company)),overflow:false};
}
