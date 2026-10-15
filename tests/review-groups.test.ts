import assert from "node:assert/strict";
import { it } from "node:test";
import { groupReviews } from "../src/domain/review-groups.ts";

const r = (
  id: string,
  company: string | null,
  title: string | null,
  employerDomain: string | null = null,
) => ({ id, company, title, employerDomain });

it("groups one interview thread, including emails that name only the company or only the sender", () => {
  assert.deepEqual(
    groupReviews([
      r("next", "Weave", "Senior Frontend Engineer", "weave.example"),
      // Shared hiring platforms reach the grouping as null: they say nothing about the employer.
      r("ats-reminder", "Weave", "Senior Frontend Engineer", null),
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

it("does not group nameless emails that only share no employer domain", () => {
  assert.deepEqual(
    groupReviews([
      r("weave", "Weave", "Senior Frontend Engineer", null),
      r("other-employer-via-ats", null, null, null),
    ]),
    [["weave"], ["other-employer-via-ats"]],
  );
});

it("shows a round chip only at an assessment or interview stage", async () => {
  const { roundOf } = await import("../app/lib.ts");
  const round = { number: 2, kind: "INTERVIEW" as const };
  assert.equal(
    roundOf({ outcome: "PENDING", stage: "INTERVIEW", round }),
    "Round 2",
  );
  // Moved back by hand: the history keeps its rounds, the chip goes.
  assert.equal(roundOf({ outcome: "PENDING", stage: "APPLIED", round }), null);
  assert.equal(
    roundOf({ outcome: "REJECTED", stage: "INTERVIEW", round }),
    null,
  );
  assert.equal(
    roundOf({
      outcome: "PENDING",
      stage: "INTERVIEW",
      round: { number: 1, kind: "INTERVIEW" },
    }),
    null,
  );
});
