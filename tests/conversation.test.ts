import assert from "node:assert/strict";
import {it} from "node:test";
import {createTestDb,seedUser,seedMailbox} from "./helpers/db.ts";
import {parseEml} from "../src/ingestion/eml.ts";
import {buildEml} from "./helpers/eml.ts";
import {ingestOriginal} from "../src/server/pipeline.ts";
import {messageIdKey,employerOpenings} from "../src/server/conversation.ts";
import type {Db} from "../src/server/db.ts";
import {gmailMessageUrl} from "../app/lib.ts";

it("verified replies resolve the accepted conversation among multiple attempts without inventing fields",async()=>{
  const t=await createTestDb();
  try{
    const user=await seedUser(t.db),mailbox=await seedMailbox(t.db,user);let serial=0;
    const ingest=async(text:string,id:string,thread?:string,reply?:string,verified=true)=>{
      let raw=buildEml({from:"Acme Careers <careers@acme.example>",to:"applicant@example.com",subject:reply?"Re: Your application to Acme":"Application received",text,date:reply?"Mon, 12 Oct 2026 09:30:00 +0000":"Mon, 05 Oct 2026 09:30:00 +0000",messageId:`<${id}@context.example>`});
      if(reply)raw=raw.replace("MIME-Version:",`In-Reply-To: <${reply}@context.example>\r\nReferences: <${reply}@context.example>\r\nMIME-Version:`);
      const [original]=await parseEml(new TextEncoder().encode(raw));
      return ingestOriginal(t.db,{userId:user,source:{kind:"GMAIL",mailboxId:mailbox,providerMessageId:`context-${++serial}`,senderAuthenticated:verified,...(thread?{providerThreadId:thread}:{})},original:original!,observedAt:new Date("2026-10-20T00:00:00Z")});
    };
    const receipt=(id:string,email:string)=>`We received your application for the Backend Engineer role at Acme.\nhttps://boards.greenhouse.io/acme/jobs/1234567\nApplication ID: ${id}\nApplicant email: ${email}`;
    const a=await ingest(receipt("APP-11111","a@example.com"),"a","thread-a");
    const b=await ingest(receipt("APP-22222","b@example.com"),"b","thread-b");
    assert.equal(a.status,"APPLIED");assert.equal(b.status,"APPLIED");if(a.status!=="APPLIED"||b.status!=="APPLIED")return;
    const reply=await ingest("Are you free Thursday for a phone screen?","reply",undefined,"a");
    assert.equal(reply.status,"APPLIED");if(reply.status==="APPLIED")assert.equal(reply.attemptId,a.attemptId);
    const stored=(await t.db.query<{fields:{title:string|null;applicantEmail:string|null}}>("SELECT s.fields FROM extracted_signals s JOIN source_artifacts a ON a.id=s.source_artifact_id WHERE a.provider_message_id='context-3'",[])).rows[0]!;
    assert.equal(stored.fields.title,null);assert.equal(stored.fields.applicantEmail,null);
    const contradiction=await ingest("Please schedule a phone screen.\nApplicant email: b@example.com","contradiction",undefined,"a");
    assert.equal(contradiction.status,"REVIEW");
    const unverified=await ingest("Please schedule a phone screen.","unverified","thread-a","a",false);
    assert.equal(unverified.status,"REVIEW");
    assert.equal((await t.db.query<{message_id_key:string}>("SELECT message_id_key FROM source_artifacts WHERE provider_message_id='context-1'")).rows[0]!.message_id_key,messageIdKey("<a@context.example>"));
  }finally{await t.close();}
});

it("a verified employer can resolve its one pending opening without a repeated job title",async()=>{
  const t=await createTestDb();try{
    const user=await seedUser(t.db),mailbox=await seedMailbox(t.db,user);let n=0;
    const ingest=async(from:string,subject:string,text:string)=>{
      const [original]=await parseEml(new TextEncoder().encode(buildEml({from,to:"applicant@example.com",subject,text,date:"Mon, 12 Oct 2026 09:30:00 +0000"})));
      return ingestOriginal(t.db,{userId:user,source:{kind:"GMAIL",mailboxId:mailbox,providerMessageId:`employer-${++n}`,senderAuthenticated:true},original:original!,observedAt:new Date("2026-10-20T00:00:00Z")});
    };
    const receipt=await ingest("Acme Robotics Careers <careers@acmerobotics.example>","Application received","We received your application for the Backend Engineer role at Acme Robotics.");
    assert.equal(receipt.status,"APPLIED");
    const followup=await ingest("Dana <dana@acmerobotics.example>","Next steps","We would love to schedule a phone screen.");
    assert.equal(followup.status,"APPLIED");
    if(receipt.status==="APPLIED"&&followup.status==="APPLIED")assert.equal(followup.attemptId,receipt.attemptId);
  }finally{await t.close();}
});

it("source links stay on Gmail and opaque hashes never expose raw Message-IDs",()=>{
  assert.equal(messageIdKey("not-an-id"),null);
  assert.match(messageIdKey("<private@example.com>")!,/^[a-f0-9]{64}$/);
  assert.equal(gmailMessageUrl("robin@example.com","../evil"),null);
  assert.equal(new URL(gmailMessageUrl("robin@example.com","18abcde123456789")!).hostname,"mail.google.com");
});

it("an overflowing employer context cannot become unique after filtering truncated candidates",async()=>{
  const rows=Array.from({length:33},(_,i)=>({id:String(i),company:i?"Other Company":"Acme",title:"Engineer"}));
  const fake={query:async()=>({rows,rowCount:rows.length})} as unknown as Db;
  const context=await employerOpenings(fake,"owner","acme.example");
  assert.equal(context.overflow,true);
  assert.equal(context.openings.length,33,"the caller must review the overflow before filtering company or title");
});
