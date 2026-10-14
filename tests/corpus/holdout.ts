/**
 * Held-out cases, written after the extractor was tuned on emails.ts and never used to tune it.
 * Their score estimates how the rules generalise to wording they were not built for. When a
 * held-out failure leads to a fix, move that case into emails.ts and write a fresh one here.
 *
 * Round 2: the round-1 set was folded into emails.ts after it informed four fixes.
 */
import type { CorpusEmail } from "./emails.ts";

export const HOLDOUT: CorpusEmail[] = [
  {
    id: "h2-greenhouse-thanks-interest",
    note: "Greenhouse: role and company split across two sentences",
    from: '"Rippling" <no-reply@us.greenhouse-mail.io>',
    subject: "Thank you for applying to Rippling",
    text: "Hi Robin,\n\nThank you for applying to Rippling. We've received your application for the Senior Product Manager, Payroll position and our recruiting team will review it shortly.\n\nRippling Recruiting",
    expect: { kind: "CONFIRMATION_RECEIVED", company: "Rippling", title: "Senior Product Manager, Payroll" },
  },
  {
    id: "h2-workday-subject-title",
    note: "Workday: title only in the subject after 'for'",
    from: '"Initrode Careers" <initrode@myworkday.com>',
    subject: "Thank you for your application for Financial Analyst",
    text: "Dear Robin,\n\nThank you for your interest in Initrode. Your application has been received and is under review.\n\nInitrode Talent Acquisition",
    expect: { kind: "CONFIRMATION_RECEIVED", company: "Initrode", title: "Financial Analyst" },
  },
  {
    id: "h2-ashby-reject",
    note: "Ashby rejection, 'other candidates' in a later sentence",
    from: '"Linear" <no-reply@ashbyhq.com>',
    subject: "Your application to Linear",
    text: "Hi Robin,\n\nThanks so much for your interest in the Design Engineer role at Linear. We received many strong applications, and after careful consideration we've decided to move forward with other candidates.\n\nBest wishes,\nThe Linear Team",
    expect: { kind: "REJECTION_RECEIVED", company: "Linear", title: "Design Engineer" },
  },
  {
    id: "h2-reject-no-longer-considered",
    note: "'no longer being considered' phrasing",
    from: '"Talent Acquisition" <talent@weyland.example>',
    subject: "Application status update",
    text: "Dear Robin,\n\nThis is to let you know that you are no longer being considered for the Field Technician position at Weyland. Thank you for your time.\n\nWeyland Talent Acquisition",
    expect: { kind: "REJECTION_RECEIVED", company: "Weyland", title: "Field Technician" },
  },
  {
    id: "h2-technical-assessment",
    note: "Technical assessment invitation from an employer domain",
    from: '"Riley Chen" <riley.chen@nakatomi.example>',
    subject: "Technical assessment - Frontend Engineer",
    text: "Hi Robin,\n\nThanks for chatting with us. The next step for the Frontend Engineer role at Nakatomi is a technical assessment. Please complete the assessment within 3 days using the link below.\n\nRiley",
    expect: { kind: "ASSESSMENT_INVITED", company: "Nakatomi", title: "Frontend Engineer" },
  },
  {
    id: "h2-interview-invite-hiring-manager",
    note: "Hiring manager invites to interview",
    from: '"Chris Wu" <chris.wu@monarch.example>',
    subject: "Invitation to interview - Product Analyst",
    text: "Hi Robin,\n\nI'm the hiring manager for the Product Analyst role at Monarch. We'd like to invite you to interview with our team. Would any of these times work for you?\n\nChris",
    expect: { kind: "INTERVIEW_INVITED", company: "Monarch", title: "Product Analyst" },
  },
  {
    id: "h2-interview-rescheduled",
    note: "Rescheduled interview",
    from: '"Recruiting" <recruiting@prestige.example>',
    subject: "Updated: your interview with Prestige Worldwide",
    text: "Hi Robin,\n\nYour interview for the Account Executive position has been rescheduled to Friday, October 30 at 1:00 PM PDT. Apologies for the change.\n\nPrestige Worldwide Recruiting",
    expect: { kind: "INTERVIEW_SCHEDULED", company: "Prestige Worldwide", title: "Account Executive" },
  },
  {
    id: "h2-offer-formal",
    note: "Formal offer letter wording",
    from: '"HR Department" <hr@gringotts.example>',
    subject: "Employment Offer - Risk Analyst",
    text: "Dear Robin,\n\nWe are delighted to offer you employment as a Risk Analyst at Gringotts. Please find your employment offer attached.\n\nGringotts HR",
    expect: { kind: "OFFER_RECEIVED", company: "Gringotts", title: "Risk Analyst" },
  },
  {
    id: "h2-indeed-variant",
    note: "Indeed with company and remote on the line",
    from: '"Indeed Apply" <indeedapply@indeed.com>',
    subject: "Indeed Application: Customer Success Manager",
    text: "Application submitted\n\nCustomer Success Manager\nBluth Company - Remote\n\nThe following items were sent to Bluth Company.",
    expect: { kind: "CONFIRMATION_RECEIVED", company: "Bluth Company", title: "Customer Success Manager" },
  },
  {
    id: "h2-promo-negative",
    note: "Promotional mail from a job board (negative)",
    from: '"ZipRecruiter" <info@ziprecruiter.com>',
    subject: "Robin, employers are looking at your profile",
    text: "3 employers viewed your profile this week. Upload a new resume to get more interview requests and job offers.",
    expect: { kind: null, company: null, title: null },
  },
  {
    id: "h2-survey-negative",
    note: "Candidate experience survey (negative)",
    from: '"Acme Careers" <careers@acme.example>',
    subject: "How was your interview experience?",
    text: "Hi Robin,\n\nWe'd love your feedback on your recent interview experience with Acme. The survey takes 2 minutes.\n\nAcme Careers",
    expect: { kind: null, company: "Acme", title: null },
  },
  {
    id: "h2-ibm-style-other-employer",
    note: "Employer-hosted portal: 'Ref: <req> - <title>' line",
    from: '"Careers" <careers@globex.example>',
    subject: "Application confirmation - 77881 - Network Engineer",
    text: "Dear Robin,\n\nThank you for submitting your application to Globex.\n\nRef: 77881 - Network Engineer\n\nGlobex Careers",
    expect: { kind: "CONFIRMATION_RECEIVED", company: "Globex", title: "Network Engineer" },
  },
];
