# First browser version — design

**Date:** 2026-10-13. **Status:** Approved by the owner in conversation ("just keep building"); written as the record, not as a review gate.

## Goal

A single-user, hosted web app the owner can open in a browser and test with real email: Gmail sync from dedicated test accounts **and** upload of selected `.eml` files, both feeding the existing evidence-backed domain (`src/domain`). It is a thin vertical slice of roadmap Phases 1–3, not the full MVP.

## Decisions taken in this slice

| # | Decision | Why |
| --- | --- | --- |
| D1 | One Next.js 16 app on Vercel (UI, route handlers, server actions, sync). Hosting is Vercel only. | One deployable; no second host account. Domain stays framework-free in `src/domain`. |
| D2 | Postgres via Neon (Vercel Marketplace). Plain SQL migrations + `pg`; tests use PGlite. | Schema tooling was an open decision; plain SQL is the smallest thing that keeps the existing migration authoritative. |
| D3 | Durable work = a Postgres table (`processing_tasks`) drained under a per-mailbox lease column. No pg-boss, no advisory locks. | Serverless has no long-lived worker; pooled Neon connections make session advisory locks unreliable. |
| D4 | Scheduler = GitHub Actions every 15 min → `POST /api/cron/sync` (bearer secret), once-daily Vercel Cron backup, plus a **Sync now** button. | Vercel Hobby cron is once/day with ±59 min precision. Pro makes this one line in `vercel.json`. |
| D5 | Login = hand-rolled Google OIDC (code + PKCE + state + nonce), allowlist in `ALLOWED_EMAILS`, signed HttpOnly session cookie. Gmail connection is a **separate** OAuth grant. | No password storage, Google MFA, no auth-library version risk. |
| D6 | Gmail access via REST `fetch`, no `googleapis`. Eligible bodies are fetched as `format=raw` and parsed by the **same** `postal-mime` path as uploaded `.eml`. | Both ingestion paths converge on one source-artifact contract (architecture §4). |
| D7 | Refresh tokens: AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY`, AAD bound to the mailbox row. Only `src/server/gmail/**` may import the decrypt function (enforced by a test). | Docs demand a connector boundary; one Vercel runtime cannot give runtime isolation — recorded as a known gap. |
| D8 | Evidence display = link to the original (`Open in Gmail`) + a **redacted, length-capped subject**. No excerpts, no bodies. | Resolves open decision #6 conservatively. |
| D9 | Extraction is deterministic rules. Terminal outcomes (rejection/offer) are accepted only on a strong phrase **and** a unique attempt match; everything else becomes a review item. | ADR-009 + fail-closed rule. |

## Pipeline

```
Gmail list/history ─┐                         ┌─> OPENING resolve ─> ATTEMPT resolve ─> event ACCEPTED
                    ├─> SourceArtifact ─> gate ─> extract ─┤
.eml upload ────────┘   (fingerprint,        (headers,    └─> ambiguity ─────────────> review item
                         original key)        secrets)
```

- A **source artifact** records origin kind, mailbox, original vs envelope timestamps, a stable fingerprint, and an *original key* (hash of RFC Message-ID + From + Date) used to detect the same original arriving via Gmail and via forward.
- A forwarded-as-attachment `.eml` yields one artifact per attached `message/rfc822`; envelope metadata is never used as applicant identity or submission time.
- Duplicate observations of one original add an artifact and evidence link, never a second signal.

## Screens

Login · Applications (openings, attempt counts, stage/outcome, coverage label, "no response observed since…") · Opening detail (attempts, masked applicant email, per-attempt evidence timeline, set status, reject event) · Needs review (assign / create / dismiss) · Connections (connect, sync health, backfill coverage, run counters, Sync now, disconnect) · Import (upload + results).

## Explicitly not in this slice

Purge-on-disconnect and account deletion, phone capture, RLS, Gmail push, model-assisted extraction, listing availability checks, Postgres-level concurrent-worker fault injection.

## Known limitations to state plainly

- Extraction rules are written against synthetic fixtures modelled on common ATS formats. Real mail will produce more review items until the corpus grows.
- Google OAuth in Testing mode expires refresh tokens after 7 days; the app marks the mailbox degraded and asks to reconnect.
- Single Vercel runtime: the Gmail-credential boundary is a code boundary, not a runtime one.
