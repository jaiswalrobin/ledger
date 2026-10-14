/**
 * Held-out cases, written after the extractor was tuned on emails.ts and never used to tune it.
 * Their score estimates how the rules generalise to wording they were not built for. When a
 * held-out failure leads to a fix, move that case into emails.ts and write a fresh one here.
 *
 * Round 2: the round-1 set was folded into emails.ts after it informed four fixes.
 * Round 4: three disclosed misses were promoted to development fixtures; the remaining
 * cases stay fixed. No replacement synthetic cases are claimed to be independent evidence.
 * Round 3: h2-interview-rescheduled moved to emails.ts after a review named its cause (the
 * "account" title filter); h3-interview-moved replaces it.
 * Round 5: six h5 cases written before the round-5 rule changes and scored once afterwards. They
 * are synthetic and share an author with the corpus, so they guard against overfitting to exact
 * wording; they are not independent evidence of real-world accuracy.
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
  // ---- round 5 ---------------------------------------------------------------------------
  {
    id: "h5-lever-thanks",
    note: "Lever confirmation: role named after 'for', no article",
    from: '"Brightline" <no-reply@hire.lever.co>',
    subject: "Thanks for applying to Brightline",
    text: "Hi Robin,\n\nThanks for your interest in Brightline! We've received your application for Staff Data Scientist and our team will be in touch if there's a fit.\n\nBest,\nBrightline Talent",
    expect: { kind: "CONFIRMATION_RECEIVED", company: "Brightline", title: "Staff Data Scientist" },
  },
  {
    id: "h5-recruiter-reject",
    note: "Recruiter rejection in a reply thread, signature names the employer",
    from: '"Dana Osei" <dana.osei@halcyon.example>',
    subject: "Re: Senior iOS Engineer",
    text: "Hi Robin,\n\nThanks again for speaking with the team last week. After a lot of discussion, we've decided not to move forward with your candidacy for the Senior iOS Engineer role. I appreciate the time you invested.\n\nDana\nTalent Partner, Halcyon",
    expect: { kind: "REJECTION_RECEIVED", company: "Halcyon", title: "Senior iOS Engineer" },
  },
  {
    id: "h5-interview-booked",
    note: "Booked video interview, 'opening' instead of 'role'",
    from: '"Orbital Recruiting" <recruiting@orbital.example>',
    subject: "Interview confirmed: Product Designer",
    text: "Hi Robin,\n\nYou're all set! Your video interview for the Product Designer opening at Orbital is booked for Wednesday, Nov 11 at 10:00 AM PT. A video link will follow.\n\nOrbital Recruiting",
    expect: { kind: "INTERVIEW_SCHEDULED", company: "Orbital", title: "Product Designer" },
  },
  {
    id: "h5-assessment",
    note: "Coding assessment, comma inside the title",
    from: '"Nimbus Hiring" <hiring@nimbus.example>',
    subject: "Next step: coding assessment",
    text: "Hi Robin,\n\nAs the next step for the Backend Engineer, Platform role at Nimbus Labs, please complete the coding assessment on CodeSignal within 5 days.\n\nNimbus Hiring",
    expect: { kind: "ASSESSMENT_INVITED", company: "Nimbus Labs", title: "Backend Engineer, Platform" },
  },
  {
    id: "h5-offer",
    note: "Offer from a hiring manager, written letter to follow",
    from: '"Priya Raman" <priya@quanta.example>',
    subject: "Great news",
    text: "Hi Robin,\n\nI'm thrilled to let you know that we'd like to offer you the Solutions Engineer position at Quanta Systems. I'll send the written offer letter tomorrow.\n\nPriya",
    expect: { kind: "OFFER_RECEIVED", company: "Quanta Systems", title: "Solutions Engineer" },
  },
  {
    id: "h5-newsletter-negative",
    note: "Career newsletter mentioning interviews (negative)",
    from: '"Hired Weekly" <news@hiredweekly.example>',
    subject: "5 tips to ace your next interview",
    text: "This week: how to prepare for a technical interview, salary negotiation basics, and 20 companies hiring now.",
    expect: { kind: null, company: null, title: null },
  },
];
