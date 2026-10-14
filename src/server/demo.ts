import { randomUUID } from "node:crypto";
import { parseEml } from "../ingestion/eml.ts";
import type { Db } from "./db.ts";
import { ingestOriginal } from "./pipeline.ts";

export function sampleEmail(
  input: {
    company?: string;
    title?: string;
    tenant?: string;
    job?: string;
    appId?: string;
    email?: string;
    phrase?: string;
    daysAgo?: number;
    id?: string;
  } = {},
): string {
  const company = input.company ?? "Acme Robotics",
    title = input.title ?? "Senior Backend Engineer";
  const date = new Date(
    Date.now() - (input.daysAgo ?? 8) * 86400000,
  ).toUTCString();
  return [
    `From: ${company} <no-reply@us.greenhouse-mail.io>`,
    `To: ${input.email ?? "first@example.com"}`,
    `Subject: Application update: ${title} at ${company}`,
    `Date: ${date}`,
    `Message-ID: <${input.id ?? "sample-application"}@example.com>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.phrase ?? "Thank you for applying. We received your application.",
    `Company: ${company}`,
    `Job Title: ${title}`,
    `Submitted email: ${input.email ?? "first@example.com"}`,
    "Location: Remote",
    `https://boards.greenhouse.io/${input.tenant ?? "acme"}/jobs/${input.job ?? "4455001"}`,
    `Application ID: ${input.appId ?? "APP-1001"}`,
    "",
  ].join("\r\n");
}
export async function seedDemo(db: Db): Promise<string> {
  const userId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query("INSERT INTO ledger_users(id)VALUES($1)", [userId]);
    await tx.query("INSERT INTO demo_workspaces(user_id)VALUES($1)", [userId]);
    const examples = [
      sampleEmail({ id: "first" }),
      sampleEmail({
        id: "second",
        email: "second@example.com",
        appId: "APP-1002",
        daysAgo: 6,
      }),
      sampleEmail({
        id: "rejected",
        phrase: "We will not be moving forward with your application.",
        daysAgo: 4,
      }),
      sampleEmail({
        id: "interview",
        phrase:
          "We invite you to an interview. Please schedule your interview.",
        email: "second@example.com",
        appId: "APP-1002",
        daysAgo: 2,
      }),
      sampleEmail({
        id: "northwind",
        company: "Northwind Labs",
        title: "Data Engineer",
        tenant: "northwind",
        job: "4455002",
        appId: "APP-2001",
        daysAgo: 7,
      }),
      sampleEmail({
        id: "assessment",
        company: "Northwind Labs",
        title: "Data Engineer",
        tenant: "northwind",
        job: "4455002",
        appId: "APP-2001",
        daysAgo: 3,
        phrase: "Please complete the online assessment.",
      }),
      sampleEmail({
        id: "juniper",
        company: "Juniper Studio",
        title: "Frontend Engineer",
        tenant: "juniper",
        job: "4455003",
        appId: "APP-3001",
        daysAgo: 5,
      }),
      sampleEmail({
        id: "orbit",
        company: "Orbit Systems",
        title: "Platform Engineer",
        tenant: "orbit",
        job: "4455004",
        appId: "APP-4001",
        daysAgo: 9,
      }),
      sampleEmail({
        id: "ambiguous",
        email: "unknown@example.com",
        daysAgo: 1,
        phrase: "We will not be moving forward with your application.",
      }).replace(/Application ID: [^\r\n]+\r?\n/, ""),
    ];
    for (const raw of examples) {
      const originals = await parseEml(Buffer.from(raw));
      for (const original of originals)
        await ingestOriginal(tx, {
          userId,
          source: { kind: "FORWARDED_EML", syntheticFixture: true },
          original,
        });
    }
  });
  return userId;
}
/** Delete expired anonymous workspaces, never persistent Google accounts. */
export async function pruneDemos(
  db: Db,
  /** Called after each committed deletion, so a later failure cannot hide earlier ones. */
  onPruned: (count: number) => void = () => undefined,
): Promise<number> {
  const expired = await db.query<{ user_id: string }>(
    "SELECT user_id FROM demo_workspaces WHERE expires_at<now() ORDER BY expires_at LIMIT 25",
  );
  let pruned = 0;
  for (const row of expired.rows) {
    await db.transaction(async (tx) => {
      const user = await tx.query(
        "SELECT id FROM ledger_users WHERE id=$1 AND login_subject IS NULL FOR UPDATE",
        [row.user_id],
      );
      if (!user.rows.length) return;
      const deleted = await tx.query(
        "DELETE FROM ledger_users WHERE id=$1 AND EXISTS(SELECT 1 FROM demo_workspaces WHERE user_id=$1 AND expires_at<now())",
        [row.user_id],
      );
      pruned += deleted.rowCount;
    });
    if (pruned) onPruned(pruned);
  }
  await db.query(
    "DELETE FROM browser_rate_limits WHERE reset_at<now()-interval '1 day'",
  );
  return pruned;
}
