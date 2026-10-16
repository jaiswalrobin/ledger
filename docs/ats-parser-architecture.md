# Reducing manual application review

## Finding

The main reported failure is **missing company or role**, rather than conflicting outcomes.
Those need different remedies. A confirmation may prove an application was received while
omitting its job title. It should not require the same decision as a contradictory rejection,
and employer-only receipts must not be merged into an arbitrary job.

The current system already has MIME parsing, privacy checks, current/quoted region separation,
weighted field candidates, versioned signals, owner-scoped conversation matching, sole-attempt
matching, reconciliation, and review grouping. More template expressions can recover missed
fields, but their value depends on how often those fields actually occur in the original mail.
The reported reason does not yet establish which architectural change has the highest impact.

Before this change, all 92 synthetic development emails and 15 fixed holdout emails scored
correctly, but five new explicit-title layouts reproduced missing titles. This is evidence of
limited test coverage, not evidence of high accuracy on the user's mailbox. The eight new ATS
examples are constructed development fixtures, not independent vendor samples or holdout data.

## Reassessment: measure and resolve identity before expanding templates

The first patch is a useful label-recovery improvement, not a demonstrated solution to the real
review queue. It implements one shared recipe behind seven provider checks. The upstream API
research establishes public posting interfaces; it does not validate those providers' receipt
templates. Adding provider names and synthetic examples must not be presented as measured ATS
coverage. The provider recipe versions are configuration today; only the overall extractor
version and field rule IDs are currently retained with the signal.

A synthetic pipeline probe exposed a separate bottleneck: a complete confirmation creates an
opening and attempt; a later assessment has the same exact public job key but omits the title.
It still receives `MISSING_JOB_DETAILS`. In `describedOpening`, the company/title prerequisite
occurs before loading the known opening by its ATS key. That means missing repeated description
can prevent use of already known identity. This is a reproducible capability gap, not a measured
explanation of the user's current queue.

Before expanding the adapter layer, compare representative original messages against both the
baseline and proposed extractor, then run their related messages through the pipeline together.
Classify misses into discovery, MIME/region loss, missed explicit fields, genuinely absent fields,
unused known identity, and ambiguous attempts. Existing `preview:parser` (with `--baseline-ref`)
and `eval:real` provide starting points. A cross-section of 25–50 labelled messages is a practical
diagnostic starting point, not a statistically reliable accuracy estimate. Keep separate unseen
employer/template families for evaluation and count wrong automatic changes as well as manual work.

The target design is application-centric: individual emails contribute partial evidence; every
email should not have to restate an application description. Separate three identities:

- A **job opening**, identified by a reviewed provider/tenant/posting key when available.
- An **application attempt**, identified by submission evidence and appropriately scoped
  application identifiers; several attempts can share one posting.
- An **email observation**, which can repeat evidence without creating another attempt.

A subsequent resolver change should try an exact existing opening identity before requiring
both descriptive fields. It must still reject contradictory company/title assertions, ambiguous
job links and cross-owner matches, and must resolve the attempt using the existing policy. A
posting ID alone never proves which reapplication an update concerns. Confirmations still need
their resend/new-submission checks; terminal events still need authenticated authority. Put this
behavior change in its own measured PR, rather than hiding it inside label parsing.

## Recommended flow

```mermaid
flowchart TD
  A[Authorized Gmail / selected original EML] --> B[MIME, privacy, current-content regions]
  B --> C[Provider fingerprint: sender domain + public job identifiers]
  C --> D[Optional provider-template rules]
  B --> E[Generic explicit fields / recruiter / calendar extraction]
  D --> F[Typed claims + rule provenance + contradictions]
  E --> F
  F --> G[Resolve known opening, then application attempt; retain conflicts]
  G --> H{Enough job information?}
  H -->|Known public posting ID| I[Optional cached public-job metadata]
  I --> J[Resolution and existing decision policy]
  H -->|Enough evidence| J
  H -->|Confirmed receipt, genuinely missing details| K[Incomplete application receipts]
  J --> L[Application timeline]
  J --> M[Conflicts / uncertain identity requiring a decision]
```

### 1. Shared extraction first, targeted provider adapters

Ordinary explicit labels and HTML field relationships are generic evidence. Their meaning should
not ultimately depend on seven sender domains. Keep common handling in a shared extraction layer;
use a provider adapter only for a demonstrated platform-specific schema, identifier or wording.
The first patch keeps its provider gate as a conservative initial scope; removing it or moving
the recipe into generic extraction needs evaluation on direct employer and non-hiring mail.

Select an adapter using exact domain boundaries or a recognized public job key. A platform name
in the display name is insufficient. Provider recognition is parsing context; authentication and
event authority remain separate policy decisions.

Each adapter should return typed candidate claims with stable rule IDs, its recipe version,
public job identity when present, missing fields, and contradiction/inspection-limit flags.
Claims also need their current-content block/row and related job identity, so the employer in
one opening cannot be paired with a role from another opening in the same email. Preserve that
association before flattening HTML; independent field scores alone do not establish a pair.
It must not mutate the database, grant sender trust, infer an applicant from the recipient,
invent an employer from a tenant slug, or fetch links while parsing. Employer-customized mail
can fall back to the generic extractor. Several platforms can share a narrowly defined recipe.

The first implemented recipe reads explicit receipt fields such as `Position applied for`,
split `Job Title` rows, and a job title linked to the exact recognized public posting. It is
selected for Greenhouse, Lever, Workday, Ashby, SmartRecruiters, iCIMS, and Workable. This is
support for that recipe on those platforms, not a claim to understand all their email templates.
Candidates use the existing validators and conflict veto. Repeated assertions retain one
support source. Bare job links, suggested jobs, private portal links, signatures and quoted
history do not provide application titles. Limits fail toward review.

HTML structure is useful for preserving field rows and anchor boundaries. A browser-compatible
HTML parser such as parse5 is a possible later replacement for the hand-written scanner, after
differential MIME/quote/privacy tests. It supplies structure, not the meaning of an application;
an AST alone cannot recover a title absent from the message.

### 2. Public posting metadata as bounded enrichment

When an email contains an exact `(provider, tenant, requisitionId)` but not a title, first consult
owner-scoped accepted job evidence. A reviewed provider integration may then request public
posting metadata using only the job identifiers. Greenhouse's Job Board interface and Lever's
Postings API expose this surface separately from employer application-management APIs.

Keep enrichment outside the MIME parser and outside the Gmail cursor transaction. Use durable
work with a strict request budget, timeouts, small response limits, exact fixed API hosts,
no redirects, no arbitrary email URLs, and a cache keyed by provider/region/tenant/posting ID.
Do not transmit message text, recipient details, private access tokens, or Google credentials.
Never request employer-only ATS credentials or call an apply/submit endpoint.

Current posting data is supplementary: it may have changed since the application. Explicit
historical email facts and owner corrections take precedence; contradictions require review.
Closed/deleted jobs and missing IDs are expected outcomes, with bounded negative caching.
Enrichment must not turn every sync into a crawl. Public API access does not imply an SLA or
unlimited quota. No paid model or extra Google Cloud service is needed for this design.

This enrichment is proposed, not enabled by the receipt-adapter change.

### 3. Track incomplete confirmations as receipts

If a confirmation names the employer but genuinely lacks a role or usable job identifier, more
parsing cannot supply the missing fact. Introduce an **unresolved application receipt** rather
than fabricating `Unknown role` as a real opening or merging it with another job at that company.

A receipt retains source identity, confirmation time, known employer, versioned claims, and an
optional resolved attempt link. Present it under Applications as **Received — job details
incomplete**, with its own count rather than inflating distinct-job or attempt totals. A later
matching email or owner correction can resolve it. Repeated delivery is idempotent; two
unresolved receipts are not automatically two distinct attempts, nor automatically duplicates.

Start with a read-model projection of eligible existing `MISSING_JOB_DETAILS` confirmation
reviews, retaining the existing resolution actions and provenance. Moving a card must not hide
required work or count as a successful automatic resolution. Add a durable receipt table only
if a concrete lifecycle requirement cannot be expressed with the existing signals/reviews; it
would need its own migration and consistency design. Other event types and conflicting
confirmations remain in review.

### 4. Make corrections useful without making them universal rules

Store accepted mappings such as `(owner, provider, tenant, posting ID) → opening`. Reuse them
when later emails carry the same identity. Never learn `company → one role`, a global employer
alias from one user's correction, or a candidate-person ID as an application identity.
The current accepted-event provenance and immutable manual corrections remain authoritative.

### 5. Repair the existing backlog deliberately

Ordinary recheck currently protects every existing review item as well as accepted events.
Consequently, a parser improvement does not automatically refresh old open review proposals.
This is an important limit for someone already looking at a large queue.

Add a separate **preview refreshed proposals** flow: re-fetch only authorized source messages,
show changed structured claims and whether the new policy would still require review, and allow
the owner to apply a bounded batch. Only untouched open proposals are eligible. Check ownership,
mailbox connection, source fingerprint, review state, and signal version in the commit transaction.
Resolved/dismissed reviews, manual corrections, and accepted/rejected events stay protected.
Do not silently change the existing recheck's contract or overwrite historical decisions.

This flow and incomplete-receipt presentation are separate implementation steps.

## Measure the work the user actually has to do

Report review counts by provider and cause: absent role, missed explicit role, absent employer,
conflicting fields, missing submission, ambiguous attempt, unsafe terminal outcome. Separate
new messages from old proposals that have not been refreshed. Existing reviews support the
reason and field-decision breakdown; they do not prove whether the original email had a title.

Measure end-to-end automatic completion, review rate, wrong automatic opening/attempt links,
false confirmations, and terminal-outcome precision, not only field extraction accuracy.
Evaluate on independently checked originals grouped by employer/template family, with a fixed
holdout excluded from rule development. Include missing-field receipts, marketing mail,
forwarded/quoted history, expired jobs, multiple jobs at one employer, and reapplications.
`npm run eval:real` already provides a private evaluation path without committing email bodies.
The user's current live review distribution has not been read from this environment.

## Implementation order

1. **Evaluate before expanding:** label representative originals, compare the baseline and the
   draft patch, and measure final application/attempt decisions across related messages. The
   draft implements conservative explicit receipt-field extraction and linked-title recovery;
   its real-mail benefit is still unmeasured.
2. **Use known identity:** resolve exact existing openings even when an email omits a repeated
   description, preserving contradiction, attempt-identity and authority checks. Add positive
   and adversarial end-to-end cases, including reapplications and multiple jobs at one company.
3. **Repair the backlog:** preview changed proposals and apply eligible untouched ones in a
   bounded batch. Parser fixes must reach existing open reviews without overwriting decisions.
4. **Handle genuinely incomplete receipts:** project them separately under Applications with
   clear counts and actions. Measure unresolved work, not just the size of the Review page.
5. **Enrich only the remaining supported cases:** public-posting requests are worthwhile only
   when an exact usable ID exists and accepted owner evidence cannot supply the missing fact.
6. **Consider model assistance only after measurement:** small classifiers or weak supervision
   may help suggest fields. Heuristic support scores are not calibrated probabilities. A remote
   LLM changes the privacy/cost model and needs a separate explicit product choice. Suggestions
   still pass the same identity, contradiction and terminal-event policy.

## Research sources

Public GitHub repository search and the upstream documents below were inspected. They establish
available parsing/API surfaces and their limits; they do not establish a universal ATS email
format or our accuracy on real mail.

- [Greenhouse's official API wrapper](https://github.com/grnhse/greenhouse_io#greenhouseiojobboard):
  separates Job Board from Harvest and documents single-job retrieval; the API token requirement
  for applying is distinct from reading public jobs. Its examples are historical; revalidate
  current public endpoint/version contracts before implementing enrichment.
- [Greenhouse's official PHP tools](https://github.com/grnhse/greenhouse-tools-php): separates Job
  API, application submission and Harvest services, and documents API-version lifecycle changes.
- [Lever Postings API](https://github.com/lever/postings-api#get-a-specific-job-posting): public
  published postings, site/posting identity, JSON `text` title, hosted/apply URLs and regional hosts.
  Reading public postings does not provide application status or applicant identity.
- [GitHub Email Reply Parser](https://github.com/github/email_reply_parser#known-issues): documents
  wrapped quotation-header and language limitations; reply extraction is a distinct problem.
- [parse5](https://github.com/inikulin/parse5): standards-based HTML parsing and serialization;
  useful structural infrastructure if scanner failures are independently demonstrated.
- [Snorkel](https://github.com/snorkel-team/snorkel): programmatic/weak-supervision approaches
  organize training signals; a model still needs independent evaluation against human labels.
