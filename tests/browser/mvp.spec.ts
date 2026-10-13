import { test, expect } from "@playwright/test";

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
  await page
    .getByRole("button", { name: "View Acme Robotics application" })
    .click();
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
