import { buildEml, type EmlSpec } from "./eml.ts";

/** Synthetic recruiting emails modelled on common ATS formats. No real people, companies or tokens. */
export const APPLICANT_A = "robin.a@example.com";
export const APPLICANT_B = "robin.b@example.net";

export function greenhouseConfirmation(
  to = APPLICANT_A,
  date = "Mon, 05 Oct 2026 09:30:00 +0000",
  id = "m-gh-1",
  applicationId: string | null = "GH-778899",
  jobId = "4455001",
): EmlSpec {
  return {
    from: '"Acme Robotics" <no-reply@us.greenhouse-mail.io>',
    to,
    subject: "Thank you for applying to Acme Robotics",
    date,
    messageId: `<${id}@greenhouse-mail.io>`,
    text: [
      "Hi Robin,",
      "",
      "Thank you for applying to Acme Robotics! We have received your application for the Senior Backend Engineer position.",
      "Our team will review it and be in touch.",
      "",
      `Job: https://boards.greenhouse.io/acmerobotics/jobs/${jobId}?gh_src=tracking123`,
      applicationId ? `Application ID: ${applicationId}` : "",
      "Location: Berlin, Germany",
      `Submitted email: ${to}`,
    ].join("\n"),
  };
}

export function leverConfirmation(
  to = APPLICANT_A,
  date = "Tue, 06 Oct 2026 11:00:00 +0000",
): EmlSpec {
  return {
    from: '"Northwind Labs" <no-reply@hire.lever.co>',
    to,
    subject: "Thanks for applying to Northwind Labs",
    date,
    messageId: "<m-lever-1@hire.lever.co>",
    text: [
      "Hi Robin,",
      "",
      "Thanks for applying for the Data Engineer role at Northwind Labs. We got your application.",
      "https://jobs.lever.co/northwindlabs/6f1c1c2e-aaaa-4bbb-8ccc-0123456789ab/apply?source=email",
      `Submitted email: ${to}`,
    ].join("\n"),
  };
}

export function workdayConfirmation(
  to = APPLICANT_A,
  date = "Wed, 07 Oct 2026 08:00:00 +0000",
): EmlSpec {
  return {
    from: '"Contoso" <contoso@myworkday.com>',
    to,
    subject: "Thank you for your application to Contoso",
    date,
    messageId: "<m-wd-1@myworkday.com>",
    text: [
      "We received your application.",
      "Job Title: Platform Engineer",
      "Requisition ID: R-20418",
      "https://contoso.wd5.myworkdayjobs.com/en-US/External/job/Seattle-WA/Platform-Engineer_R-20418?source=LinkedIn",
      `Submitted email: ${to}`,
    ].join("\n"),
  };
}

export function interviewInvite(
  to = APPLICANT_A,
  date = "Mon, 12 Oct 2026 14:00:00 +0000",
  applicationId: string | null = "GH-778899",
): EmlSpec {
  return {
    from: '"Dana Lee" <dana.lee@acmerobotics.example>',
    to,
    subject: "Interview invitation: Senior Backend Engineer at Acme Robotics",
    date,
    messageId: "<m-int-1@acmerobotics.example>",
    text: [
      "Hi Robin,",
      "",
      "Thanks for applying. We would like to invite you to interview for the Senior Backend Engineer position.",
      "Please reply with times that work for a first call.",
      applicationId ? `Application ID: ${applicationId}` : "",
      `Submitted email: ${to}`,
    ].join("\n"),
  };
}

export function assessmentInvite(to = APPLICANT_A): EmlSpec {
  return {
    from: '"Northwind Labs" <no-reply@hire.lever.co>',
    to,
    subject: "Your application to Northwind Labs: next step",
    date: "Thu, 08 Oct 2026 10:00:00 +0000",
    messageId: "<m-assess-1@hire.lever.co>",
    text: "Please complete the online assessment for the Data Engineer role at Northwind Labs within 5 days.\nhttps://jobs.lever.co/northwindlabs/6f1c1c2e-aaaa-4bbb-8ccc-0123456789ab",
  };
}

export function rejection(
  to = APPLICANT_A,
  applicationId: string | null = "GH-778899",
): EmlSpec {
  return {
    from: '"Acme Robotics" <no-reply@us.greenhouse-mail.io>',
    to,
    subject: "Update on your application to Acme Robotics",
    date: "Fri, 16 Oct 2026 09:00:00 +0000",
    messageId: "<m-rej-1@greenhouse-mail.io>",
    text: [
      "Hi Robin,",
      "",
      "Thank you for your interest in the Senior Backend Engineer position at Acme Robotics.",
      "Unfortunately, we have decided to move forward with other candidates at this time.",
      applicationId ? `Application ID: ${applicationId}` : "",
      `Submitted email: ${to}`,
    ].join("\n"),
  };
}

export function offer(to = APPLICANT_A): EmlSpec {
  return {
    from: '"Dana Lee" <dana.lee@acmerobotics.example>',
    to,
    subject: "Offer of employment: Senior Backend Engineer at Acme Robotics",
    date: "Mon, 19 Oct 2026 10:00:00 +0000",
    messageId: "<m-offer-1@acmerobotics.example>",
    text: "We are pleased to offer you the Senior Backend Engineer position.\nApplication ID: GH-778899",
  };
}

export function otpMessage(): EmlSpec {
  return {
    from: '"Acme Robotics" <no-reply@us.greenhouse-mail.io>',
    to: APPLICANT_A,
    subject: "Your verification code for your application",
    date: "Mon, 05 Oct 2026 09:20:00 +0000",
    messageId: "<m-otp-1@greenhouse-mail.io>",
    text: "Your code is 482913. Use it to sign in.",
  };
}

export function newsletter(): EmlSpec {
  return {
    from: '"Career Tips" <hello@tips.example.com>',
    to: APPLICANT_A,
    subject: "Five application tips to get more interviews",
    date: "Mon, 05 Oct 2026 07:00:00 +0000",
    messageId: "<m-news-1@tips.example.com>",
    text: "Read our guide to better applications.",
  };
}

export const eml = (spec: EmlSpec): string => buildEml(spec);
