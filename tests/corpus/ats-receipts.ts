import type { CorpusEmail } from "./emails.ts";

/** New development examples, constructed to reproduce missed explicit ATS receipt fields.
 * These are synthetic layouts, not captured or guaranteed default vendor templates. */
export const ATS_RECEIPT_CORPUS: CorpusEmail[] = [
  {
    id: "ats-greenhouse-applied-label",
    note: "Extended receipt label on one line",
    from: '"Careers" <talent@greenhouse-mail.io>',
    subject: "Thank you for applying to Northstar Labs!",
    text: "We received your application.\nPosition applied for: Staff Engineer",
    expect: {
      kind: "CONFIRMATION_RECEIVED",
      company: "Northstar Labs",
      title: "Staff Engineer",
    },
  },
  {
    id: "ats-greenhouse-linked-title",
    note: "Explicit job-title field contains the public posting anchor",
    from: '"Careers" <talent@greenhouse-mail.io>',
    subject: "Thank you for applying to Pine Robotics!",
    html: '<p>We received your application.</p><p>Job Title: <a href="https://boards.greenhouse.io/pinerobotics/jobs/12345">Platform Engineer</a></p>',
    expect: {
      kind: "CONFIRMATION_RECEIVED",
      company: "Pine Robotics",
      title: "Platform Engineer",
    },
  },
  {
    id: "ats-lever-split-title",
    note: "A split label is not a prose fragment",
    from: '"Careers" <talent@hire.lever.co>',
    subject: "Your application to Mosaic Research",
    text: "We received your application.\nPosition applied for\nStaff Frontend Engineer",
    expect: {
      kind: "CONFIRMATION_RECEIVED",
      company: "Mosaic Research",
      title: "Staff Frontend Engineer",
    },
  },
  {
    id: "ats-workday-split-title",
    note: "Role and requisition are separate receipt fields",
    from: '"Careers" <talent@myworkday.com>',
    subject: "Your application to Sequoia Tools",
    text: "We received your application.\nJob Title\nBackend Engineer\nRequisition ID\nJR-12345",
    expect: {
      kind: "CONFIRMATION_RECEIVED",
      company: "Sequoia Tools",
      title: "Backend Engineer",
    },
  },
  {
    id: "ats-ashby-applied-label",
    note: "Applied-position label",
    from: '"Careers" <talent@ashbyhq.com>',
    subject: "Your application to Cedar Systems",
    text: "We received your application.\nApplied position: Data Engineer",
    expect: {
      kind: "CONFIRMATION_RECEIVED",
      company: "Cedar Systems",
      title: "Data Engineer",
    },
  },
  {
    id: "ats-smartrecruiters-split-title",
    note: "Split role field with one empty layout line",
    from: '"Careers" <talent@smartrecruiters.com>',
    subject: "Your application to Willow Engineering",
    text: "We received your application.\nRole applied for:\n\nFrontend Engineer",
    expect: {
      kind: "CONFIRMATION_RECEIVED",
      company: "Willow Engineering",
      title: "Frontend Engineer",
    },
  },
  {
    id: "ats-icims-split-title",
    note: "Split position-title field",
    from: '"Careers" <talent@icims.com>',
    subject: "Your application to Marigold Health",
    text: "We received your application.\nPosition title\nSoftware Developer II",
    expect: {
      kind: "CONFIRMATION_RECEIVED",
      company: "Marigold Health",
      title: "Software Developer II",
    },
  },
  {
    id: "ats-workable-split-employer",
    note: "Both employer and role occur only in explicit receipt fields",
    from: '"Careers" <talent@workablemail.com>',
    subject: "Application received",
    text: "We received your application.\nEmployer name\nOsprey Studio\nApplied role: Product Designer",
    expect: {
      kind: "CONFIRMATION_RECEIVED",
      company: "Osprey Studio",
      title: "Product Designer",
    },
  },
];
