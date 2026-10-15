import { test, expect } from "@playwright/test";
import { buildEml } from "../helpers/eml.ts";

test("browser MVP: demo, independent attempts, review, corrections, and durable reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Every application/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Your next chapter." }),
  ).toBeVisible();
  await expect(page.getByText("Acme Robotics", { exact: true })).toBeVisible();
  await expect(page.getByText("Northwind Labs", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/ledger-dashboard.png", fullPage: true });
  await page
    .getByRole("button", { name: "View Acme Robotics application" })
    .click();
  await expect(page.getByText("2 independent attempts")).toBeVisible();
  await expect(
    page.getByText("Rejected", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator(".pill.interview")).toBeVisible();
  await page.getByRole("button", { name: "Reject update" }).nth(1).click();
  await expect(
    page.locator(".attempt-card").first().locator(".pill.pending"),
  ).toBeVisible();
  await page.reload();
  // The open application is part of the URL, so a reload returns to it.
  await expect(page.getByText("2 independent attempts")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(
    page.getByText("Rejected", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Needs review" })
    .click();
  await expect(
    page.getByRole("heading", { name: "A closer look." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "You’re all caught up." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect Gmail" }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});

test("email upload runs the real parser and survives reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await page
    .getByRole("button", { name: "Import emails", exact: true })
    .first()
    .click();
  const raw = [
    "From: Acme Robotics <no-reply@us.greenhouse-mail.io>",
    "To: first@example.com",
    "Subject: Application received: Backend Engineer at Test Company",
    "Date: Mon, 05 Oct 2026 10:00:00 +0000",
    "Message-ID: <browser-import@example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Thank you for applying. We received your application.",
    "Company: Test Company",
    "Job Title: Backend Engineer",
    "Submitted email: first@example.com",
    "https://boards.greenhouse.io/testcompany/jobs/99887766",
    "Application ID: TEST-998877",
  ].join("\r\n");
  await page.getByLabel("Email files").setInputFiles({
    name: "synthetic-test.eml",
    mimeType: "message/rfc822",
    buffer: Buffer.from(raw),
  });
  await page.getByRole("button", { name: "Import selected emails" }).click();
  await expect(
    page.getByText("Added to your timeline", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View your ledger" }).click();
  await expect(page.getByText("Test Company", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Test Company", { exact: true })).toBeVisible();
});

test("calendar imports show an upcoming interview and rejecting it removes the agenda entry", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await page
    .getByRole("button", { name: "Import emails", exact: true })
    .first()
    .click();
  const now = Date.now(),
    start = new Date(now + 2 * 86400000);
  const stamp = (date: Date) =>
    date
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  const common = {
    from: "Agenda Labs Careers <careers@agendalabs.example>",
    to: "applicant@example.com",
  };
  const receipt = buildEml({
    ...common,
    subject: "Application received",
    date: new Date(now - 7200000).toUTCString(),
    text: "We received your application for the Backend Engineer role at Agenda Labs.\nApplication ID: AGENDA-11111",
  });
  const calendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:browser-agenda@example.com",
    "SEQUENCE:1",
    `DTSTAMP:${stamp(new Date(now - 3600000))}`,
    `DTSTART:${stamp(start)}`,
    "SUMMARY:Technical Interview - Backend Engineer",
    "DESCRIPTION:Interview for the Backend Engineer role at Agenda Labs.",
    "ORGANIZER:mailto:careers@agendalabs.example",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const invitation = buildEml({
    ...common,
    subject: "Interview invitation",
    date: new Date(now - 3600000).toUTCString(),
    text: "Application ID: AGENDA-11111",
    attachments: [
      {
        filename: "interview.ics",
        mime: "text/calendar; method=REQUEST",
        content: calendar,
      },
    ],
  });
  await page.getByLabel("Email files").setInputFiles([
    {
      name: "agenda-receipt.eml",
      mimeType: "message/rfc822",
      buffer: Buffer.from(receipt),
    },
    {
      name: "agenda-invitation.eml",
      mimeType: "message/rfc822",
      buffer: Buffer.from(invitation),
    },
  ]);
  await page.getByRole("button", { name: "Import selected emails" }).click();
  await expect(
    page.getByText("Added to your timeline", { exact: true }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "View your ledger" }).click();
  const agenda = page.getByRole("region", { name: "Upcoming interviews" });
  await expect(agenda).toBeVisible();
  const entry = agenda.getByRole("button", { name: /Agenda Labs/ });
  await expect(entry.locator("time")).toHaveAttribute(
    "datetime",
    new Date(Math.floor(start.getTime() / 1000) * 1000).toISOString(),
  );
  await entry.click();
  const scheduled = page
    .locator(".timeline-event")
    .filter({ hasText: "Interview scheduled" });
  await expect(scheduled.getByText(/Current interview time:/)).toBeVisible();
  await scheduled.getByRole("button", { name: "Reject update" }).click();
  await expect(
    scheduled.getByRole("button", { name: "Restore" }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Applications", exact: true })
    .click();
  await expect(agenda).toHaveCount(0);
  await page.reload();
  await expect(agenda).toHaveCount(0);
});

test("HTTP ownership, CSRF, cron authentication, and logout revocation fail closed", async ({
  browser,
  baseURL,
}) => {
  const first = await browser.newContext({ baseURL: baseURL! }),
    second = await browser.newContext({ baseURL: baseURL! });
  const origin = baseURL!;
  expect(
    (
      await first.request.post("/api/demo", {
        headers: { Origin: origin },
        data: {},
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await second.request.post("/api/demo", {
        headers: { Origin: origin },
        data: {},
      })
    ).ok(),
  ).toBeTruthy();
  const dashboard = await (await first.request.get("/api/dashboard")).json();
  expect(
    (
      await first.request.post("/api/recheck", {
        headers: { Origin: origin },
        data: { mailboxId: "00000000-0000-4000-8000-000000000000" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await second.request.get(`/api/openings/${dashboard.openings[0].id}`)
    ).status(),
  ).toBe(404);
  expect(
    (
      await second.request.post("/api/status", {
        headers: { Origin: origin },
        data: {
          attemptId: dashboard.openings[0].attempts[0].id,
          stage: "INTERVIEW",
          outcome: "REJECTED",
        },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await first.request.post("/api/demo", {
        headers: { Origin: "https://evil.example" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await first.request.post("/api/import", {
        headers: { Origin: origin },
        data: Buffer.alloc(4 * 1024 * 1024),
      })
    ).status(),
  ).toBe(413);
  expect([401, 503]).toContain(
    (await first.request.get("/api/cron/sync")).status(),
  );
  const cookies = await first.cookies();
  const token = cookies.find((c) => c.name === "ledger_session")!;
  expect(token.httpOnly).toBeTruthy();
  expect(token.sameSite).toBe("Lax");
  expect(
    (
      await first.request.post("/api/logout", {
        headers: { Origin: origin },
        data: {},
      })
    ).ok(),
  ).toBeTruthy();
  await first.addCookies([token]);
  expect((await first.request.get("/api/dashboard")).status()).toBe(401);
  await first.close();
  await second.close();
});

test("mobile navigation and workspace deletion work", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Your next chapter." }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/ledger-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("button", { name: "Workspace settings" }).click();
  await page.getByLabel("Deletion confirmation").fill("DELETE");
  await page.getByRole("button", { name: "Delete workspace" }).click();
  await expect(
    page.getByRole("heading", { name: /Every application/ }),
  ).toBeVisible();
});

test("a review can be assigned and unsupported mail can be interpreted explicitly", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Needs review" })
    .click();
  await page
    .getByLabel("Choose application attempt")
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: "Accept and assign" }).click();
  await expect(
    page.getByRole("heading", { name: "You’re all caught up." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Import emails", exact: true })
    .first()
    .click();
  const raw = [
    "From: Updates <updates@example.com>",
    "To: owner@example.com",
    "Subject: Application notes",
    "Date: Mon, 05 Oct 2026 10:00:00 +0000",
    "Message-ID: <manual-browser@example.com>",
    "Content-Type: text/plain",
    "",
    "Here is a note I selected for my records.",
  ].join("\r\n");
  await page.getByLabel("Email files").setInputFiles({
    name: "manual.eml",
    mimeType: "message/rfc822",
    buffer: Buffer.from(raw),
  });
  await page.getByRole("button", { name: "Import selected emails" }).click();
  await expect(
    page.getByText("Saved for review", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Needs review" })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: "Create an application from this email" })
    .click();
  await page.getByLabel("Company", { exact: true }).fill("Manual Example");
  await page.getByLabel("Role", { exact: true }).fill("Analyst");
  await page
    .getByLabel("Event type", { exact: true })
    .selectOption("CONFIRMATION_RECEIVED");
  await page
    .getByRole("button", { name: "Create application", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "You’re all caught up." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Applications", exact: true }).click();
  await expect(page.getByText("Manual Example", { exact: true })).toBeVisible();
});

test("review creation uses an existing opening without dummy fields, and submission dates can be corrected", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Explore the demo" }).click();
  await page
    .getByRole("button", { name: "Import emails", exact: true })
    .first()
    .click();
  const raw = [
    "From: Updates <updates@example.com>",
    "To: test@example.com",
    "Subject: Application notes",
    `Date: ${new Date(Date.now() - 86400000).toUTCString()}`,
    "Message-ID: <existing-opening-browser@example.com>",
    "Content-Type: text/plain",
    "",
    "A selected note without employer or role fields.",
  ].join("\r\n");
  await page.getByLabel("Email files").setInputFiles({
    name: "existing.eml",
    mimeType: "message/rfc822",
    buffer: Buffer.from(raw),
  });
  await page.getByRole("button", { name: "Import selected emails" }).click();
  await expect(
    page.getByText("Saved for review", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Needs review" })
    .click();
  const card = page.locator(".review-card").filter({
    has: page.getByRole("heading", {
      name: "Application notes",
      exact: true,
    }),
  });
  await card.locator("summary").click();
  await card
    .getByLabel("Job opening", { exact: true })
    .selectOption({ label: "Juniper Studio · Frontend Engineer" });
  await expect(card.getByLabel("Company", { exact: true })).toHaveValue("");
  await expect(card.getByLabel("Role", { exact: true })).toHaveValue("");
  await card
    .getByLabel("Event type", { exact: true })
    .selectOption("CONFIRMATION_RECEIVED");
  await card
    .getByRole("button", { name: "Create application", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Applications", exact: true })
    .click();
  await page
    .getByRole("button", { name: "View Juniper Studio application" })
    .click();
  await expect(page.getByText("2 independent attempts")).toBeVisible();
  const attempt = page.locator(".attempt-card").last();
  await attempt
    .locator("summary")
    .filter({ hasText: "Correct submission date" })
    .click();
  const fixed = new Date(Date.now() - 2 * 86400000);
  fixed.setSeconds(0, 0);
  const local = new Date(fixed.getTime() - fixed.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await attempt
    .getByLabel("Submission date and time", { exact: true })
    .fill(local);
  await attempt.getByRole("button", { name: "Save submission date" }).click();
  await expect(page.getByText(/Submission date corrected from/)).toBeVisible();
  await page.reload();
  await expect(page.getByText("2 independent attempts")).toBeVisible();
  await expect(page.getByText(/Submission date corrected from/)).toBeVisible();
});

test("connections explain email counts and preserve partial recheck progress", async ({
  page,
}) => {
  const mailboxId = "00000000-0000-4000-8000-000000000001";
  const mailbox = {
    id: mailboxId,
    address: "jobs@example.org",
    syncState: "HEALTHY",
    backfillComplete: true,
    backfillStart: "2026-08-21T00:00:00Z",
    backfillEnd: "2026-10-20T00:00:00Z",
    lastSuccessAt: "2026-10-20T00:00:00Z",
    lastAttemptAt: "2026-10-20T00:00:00Z",
    lastErrorCode: null,
    pendingTasks: 0,
    failedTasks: 0,
    lastRun: null,
    recheckInProgress: false,
    processingSummary: {
      processed: 4,
      skippedSensitive: 1,
      unrecognized: 2,
      skippedOther: 3,
      quarantined: 1,
      partiallyProcessed: 0,
    },
    excludedMessages: [
      {
        messageId: "abcdef123456",
        reason: "PRIVACY_CHECK",
        originalMessageAt: "2026-09-30T02:59:00Z",
      },
    ],
  };
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        session: {
          userId: "00000000-0000-4000-8000-000000000002",
          email: "jobs@example.org",
          isDemo: false,
        },
        demoEnabled: false,
        googleReady: true,
      },
    }),
  );
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({
      json: { openings: [], reviews: [], mailboxes: [mailbox] },
    }),
  );
  await page.route("**/api/recheck", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ mailboxId });
    mailbox.recheckInProgress = true;
    mailbox.pendingTasks = 2;
    await route.fulfill({ json: { runs: [{ mailboxId, status: "PARTIAL" }] } });
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Connections", exact: true })
    .click();
  const totals = page.getByLabel("Email processing totals");
  await expect(totals).toContainText("4 emails used for timelines or review");
  await expect(totals).toContainText("1 excluded by privacy checks");
  await expect(
    page.getByText(/A completed sync does not guarantee/),
  ).toBeVisible();
  await page.getByText("See recent excluded emails").click();
  await expect(
    page.getByRole("link", { name: "Open in Gmail" }),
  ).toHaveAttribute(
    "href",
    "https://mail.google.com/mail/?authuser=jobs%40example.org#all/abcdef123456",
  );
  await page.getByRole("button", { name: "Recheck last 60 days" }).click();
  await expect(page.locator(".notice[role='alert']")).toContainText(
    "Some work remains",
  );
  await expect(
    page.getByRole("button", { name: "Recheck last 60 days" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
});
