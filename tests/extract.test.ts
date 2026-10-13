import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractSignal } from "../src/ingestion/extract.ts";
import { parseEml } from "../src/ingestion/eml.ts";
import { buildEml, type EmlSpec } from "./helpers/eml.ts";
import {
  APPLICANT_A,
  assessmentInvite,
  greenhouseConfirmation,
  interviewInvite,
  leverConfirmation,
  newsletter,
  offer,
  rejection,
  workdayConfirmation,
} from "./helpers/fixtures.ts";

async function extract(spec: EmlSpec) {
  const [parsed] = await parseEml(new TextEncoder().encode(buildEml(spec)));
  return extractSignal(parsed!.message);
}

describe("confirmations", () => {
  it("Greenhouse: company, title, scoped ATS key, canonical URL without tracking, application id, applicant", async () => {
    const s = await extract(greenhouseConfirmation());
    assert.equal(s.kind, "CONFIRMATION_RECEIVED");
    assert.equal(s.confidence, "HIGH");
    assert.equal(s.fields.company, "Acme Robotics");
    assert.equal(s.fields.title, "Senior Backend Engineer");
    assert.equal(s.fields.location, "Berlin, Germany");
    assert.deepEqual(s.fields.atsKey, {
      provider: "greenhouse",
      tenant: "acmerobotics",
      requisitionId: "4455001",
    });
    assert.equal(
      s.fields.canonicalUrl,
      "https://boards.greenhouse.io/acmerobotics/jobs/4455001",
    );
    assert.equal(s.fields.externalApplicationId, "GH-778899");
    assert.equal(s.fields.applicantEmail, APPLICANT_A);
    assert.equal(s.occurredAt, "2026-10-05T09:30:00.000Z");
  });

  it("Lever: title and company from the sentence, key from the job URL, query stripped", async () => {
    const s = await extract(leverConfirmation());
    assert.equal(s.kind, "CONFIRMATION_RECEIVED");
    assert.equal(s.fields.company, "Northwind Labs");
    assert.equal(s.fields.title, "Data Engineer");
    assert.deepEqual(s.fields.atsKey, {
      provider: "lever",
      tenant: "northwindlabs",
      requisitionId: "6f1c1c2e-aaaa-4bbb-8ccc-0123456789ab",
    });
    assert.equal(
      s.fields.canonicalUrl,
      "https://jobs.lever.co/northwindlabs/6f1c1c2e-aaaa-4bbb-8ccc-0123456789ab",
    );
  });

  it("Workday: tenant from host, requisition from the job path", async () => {
    const s = await extract(workdayConfirmation());
    assert.equal(s.kind, "CONFIRMATION_RECEIVED");
    assert.equal(s.fields.title, "Platform Engineer");
    assert.deepEqual(s.fields.atsKey, {
      provider: "workday",
      tenant: "contoso",
      requisitionId: "R-20418",
    });
  });
});

describe("updates", () => {
  it("interview invitation names title and company from the subject", async () => {
    const s = await extract(interviewInvite());
    assert.equal(s.kind, "INTERVIEW_INVITED");
    assert.equal(s.fields.title, "Senior Backend Engineer");
    assert.equal(s.fields.company, "Acme Robotics");
    assert.equal(s.fields.externalApplicationId, "GH-778899");
    assert.equal(s.fields.atsKey, null);
  });

  it("assessment invitation", async () => {
    const s = await extract(assessmentInvite());
    assert.equal(s.kind, "ASSESSMENT_INVITED");
    assert.equal(s.fields.company, "Northwind Labs");
  });

  it("rejection wins over the thank-you boilerplate", async () => {
    const s = await extract(rejection());
    assert.equal(s.kind, "REJECTION_RECEIVED");
    assert.equal(s.fields.company, "Acme Robotics");
    assert.equal(s.fields.externalApplicationId, "GH-778899");
  });

  it("offer", async () => {
    const s = await extract(offer());
    assert.equal(s.kind, "OFFER_RECEIVED");
  });

  it("interview scheduled is preferred over interview invited when both phrases appear", async () => {
    const s = await extract({
      ...interviewInvite(),
      text: "We would like to schedule an interview. Your interview is confirmed for Tuesday at 10:00.",
    });
    assert.equal(s.kind, "INTERVIEW_SCHEDULED");
  });
});

describe("fail-closed behaviour", () => {
  it("a message that is both rejection and offer is unrecognised, not guessed", async () => {
    const s = await extract({
      ...rejection(),
      text: "We regret to inform you the role is filled. We are pleased to offer you a different role.",
    });
    assert.equal(s.kind, null);
    assert.equal(s.confidence, "LOW");
  });

  it("an unrelated newsletter yields no kind", async () => {
    assert.equal((await extract(newsletter())).kind, null);
  });

  it("does not treat the word 'unfortunately' alone as rejection", async () => {
    const s = await extract({
      ...greenhouseConfirmation(),
      text: "Thank you for applying. Unfortunately we cannot reply to each applicant individually.",
    });
    assert.equal(s.kind, "CONFIRMATION_RECEIVED");
  });

  it("leaves the applicant email unknown when there are several recipients", async () => {
    const s = await extract({
      ...greenhouseConfirmation(),
      to: [APPLICANT_A, "other@example.com"],
      text: greenhouseConfirmation().text!.replace(/^Submitted email:.*$/m, ""),
    });
    assert.equal(s.fields.applicantEmail, null);
  });

  it("never lifts a title that is really a status phrase", async () => {
    const s = await extract({
      ...rejection(),
      subject: "Update on your application at Acme Robotics",
      text: "We will not be moving forward with your application.",
    });
    assert.equal(s.fields.title, null);
  });

  it("does not use signed or tokenised links as a canonical URL", async () => {
    const s = await extract({
      ...greenhouseConfirmation(),
      text: "Thank you for applying to Acme Robotics.\nhttps://track.example.com/c/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf?sig=zzz",
    });
    assert.equal(s.fields.canonicalUrl, null);
    assert.equal(s.fields.atsKey, null);
  });
});
