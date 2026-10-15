import assert from "node:assert/strict";
import { it } from "node:test";
import { groupReviews } from "../src/domain/review-groups.ts";

const r = (
  id: string,
  company: string | null,
  title: string | null,
  senderDomain: string | null = null,
) => ({ id, company, title, senderDomain });

it("groups one interview thread, including emails that name only the company or only the sender", () => {
  assert.deepEqual(
    groupReviews([
      r("next", "Weave", "Senior Frontend Engineer", "weave.example"),
      r("ats-reminder", "Weave", "Senior Frontend Engineer", "ashbyhq.com"),
      r("details", "weave", "senior frontend engineer", "weave.example"),
      r("reschedule", "Weave", null, "weave.example"),
      r("no-names", null, null, "weave.example"),
      r("other", "Globex", "Data Engineer", "globex.example"),
    ]),
    [["next", "ats-reminder", "details", "reschedule", "no-names"], ["other"]],
  );
});

it("keeps different roles at one company apart, and does not guess between them", () => {
  assert.deepEqual(
    groupReviews([
      r("a", "Acme", "Backend Engineer", "acme.example"),
      r("b", "Acme", "Data Engineer", "acme.example"),
      r("company-only", "Acme", null, "acme.example"),
      r("domain-only", null, null, "acme.example"),
    ]),
    [["a"], ["b"], ["company-only"], ["domain-only"]],
  );
});

it("lets a company-only group take the first email that names a role", () => {
  assert.deepEqual(
    groupReviews([
      r("company-only", "Acme", null),
      r("titled", "Acme", "Backend Engineer"),
      r("other-title", "Acme", "Data Engineer"),
    ]),
    [["company-only", "titled"], ["other-title"]],
  );
});

it("never groups emails with nothing in common", () => {
  assert.deepEqual(groupReviews([r("a", null, null), r("b", null, null)]), [
    ["a"],
    ["b"],
  ]);
});
