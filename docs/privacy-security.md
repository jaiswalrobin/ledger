# Privacy and security model

**Status:** Initial threat model and requirements, not a compliance certification.

## 1. Trust model

**Preferred V1 onboarding:** dedicated or rarely used job-search Gmail account(s) for continuing synchronization; primary personal Gmail **not connected**. Legacy applications are selectively imported by forwarding .eml messages. A user can log in to Ledger separately from authorizing Gmail read access.

A dedicated inbox **still contains secrets** (ATS OTPs, password-reset links, access tokens, assessment links) and private correspondence. It is not intrinsically safe. Google's **gmail.readonly** scope is a **restricted scope** granting broad authorized mailbox access. Gmail API query/label filtering limits what Ledger chooses to fetch; it is **not** an OAuth-enforced "jobs-only" permission. Do not market that stronger claim.

## 2. Assets and threat actors

Assets:
- OAuth refresh/access tokens and account identifiers
- Applicant email and phone variants
- Interview schedule and offer/rejection history
- Links with login/assessment tokens or personal identifying data
- Raw email bodies temporarily accessible in ingestion process

Threats:
- Credential theft, impersonation, or cross-user access
- Overly broad Gmail reads, mistaken OTP processing, accidental persistence of secrets
- Untrusted MIME payloads, malicious HTML or attachment bombs
- Email prompt injection / malicious sender instructions targeting extraction logic
- Background-worker logging and third-party telemetry exfiltration
- Duplicate/incorrect event assignment causing false rejection or offer
- Unintended data access through AI inference providers or error-monitoring tools

## 3. Required controls before accessing real inboxes

**Authentication and authorization**
- HTTPS, secure cookies, CSRF protection on relevant state-changing routes; validate OAuth **state** and bind callback to initiating user/session.
- Store Google subject and mailbox-to-user mapping; never accept arbitrary mailbox IDs from client requests without authorization.
- Encrypt refresh tokens with managed keys and limited decryption access; plan key rotation and token revocation. No tokens in repo, logs, frontend, or error telemetry.
- Keep the Gmail connector isolated from API/UI and general workers at the runtime credential boundary.
- Require owner-scoped joins, constraints and authorization checks for every source, attempt, and evidence link. Production multi-tenancy needs tested row-level isolation.

**Data minimization**
- Candidate ID search → metadata/header inspection → restricted transient body fetch only if eligible.
- Conservative **sensitive-message exclusion** based on sender + subject (OTP, verification, password reset, sign-in links); fail closed when uncertain. Header checks are a partial defense, **not a guarantee** no sensitive body ever enters memory.
- The transient body screen (`hasSensitiveContent`) discards messages that **deliver or act on a credential**: OTP or verification phrases, "your passcode is …", password-reset or sign-in links (a tokenized URL whose own host/path names login/reset/verify), and bare bearer tokens. Opaque tracking/unsubscribe query tokens and meeting passcodes alone do **not** discard a message; they appear in almost every ATS email, and none of them is persisted (`safeField` rejects URL- and token-shaped values; canonical URLs come only from reviewed ATS schemas, without query strings).
- Parse only needed plain text; disable remote HTML resource loading, JS evaluation, URL visits, unsafe attachments and active content. Strict MIME/size limits for .eml.
- Extract typed minimal events and discard raw payloads after request processing. No persistent full email-body, attachment or raw-token storage in V1.
- Redact credentials, signed URLs, verification codes, and unnecessary PII **before** any model request or persistent evidence excerpt.
- No third-party LLM email-content transfers in V1. Model fallback requires a separately reviewed data flow, explicit user choice, and provider-policy review.

**Auditability and operational safety**
- Aggregate mailbox-access counters: discovered IDs, headers inspected, bodies retrieved, skipped-sensitive, accepted and unresolved, plus sync state.
- Logs and traces must not include email subject/body, raw from/to headers, OAuth credentials, assessment tokens or phone numbers. Use stable internal random IDs and safe failure codes.
- Treat email text as **data**, never instructions; no tool/action execution based on message contents.
- A source classification may propose an event, but irreversible/terminal updates must pass evidence thresholds or manual review.
- Validate and sanitize all data shown in the UI to avoid stored XSS.

## 4. User controls and lifecycle

- Explicitly show which connected mailboxes are scanned and each mailbox's last healthy sync.
- Clearly label historical imports as **manual/forwarded**, not automatically monitored.
- Allow disconnect and token revocation. Offer separately **preserve user-owned application history** and **purge mailbox-derived data**, with the consequences explained.
- Support full account deletion and downstream deletion of stored personal data; define backup expiry and audit retention before production.
- Never retain email data indefinitely by accident. The **60-day import window is not a deletion policy**; a production retention policy remains an open decision.
- Provide a view showing why an application was updated and where the evidence came from, without revealing secrets.

## 5. Explicitly out of scope

- Reading primary Gmail without direct authorization
- Ingesting entire mailboxes into an AI provider
- Sending replies or submitting applications through Gmail OAuth
- Auto-reading, storing or using OTPs; bypassing identity checks or ATS rules
- Persisting sensitive credentials from recruiter correspondence
- Claiming the app can guarantee secret-free processing when it holds read-only Gmail access

## 6. Google OAuth production gate

Gmail **gmail.readonly** and **gmail.metadata** are both restricted. Apps that do not qualify for a documented exception must complete Google's restricted-scope verification before public use; transmitting/storing restricted Gmail data on third-party servers can require a third-party security assessment and ongoing recertification. Test/personal-use exceptions have conditions and do **not** eliminate security duties.

No production/public deployment decision until scope selection, user-data policy, deletion process, app verification, and security-assessment applicability are evaluated.

References:
- [Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [OAuth policy compliance](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
- [Gmail message get formats](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
