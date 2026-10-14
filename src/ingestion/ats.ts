/**
 * Sender domains of hosted applicant-tracking and assessment platforms.
 *
 * Two deliberately different lists:
 * - TRUSTED: platforms whose DMARC-aligned mail may support an automatic terminal change. Every
 *   tenant is an employer, so an authenticated message really came through that employer's ATS.
 * - RECRUITING: everything above plus platforms that only ever send hiring mail. Used to widen
 *   discovery and header screening (recall); never as authority for an outcome.
 */
export const TRUSTED_ATS_DOMAINS = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "myworkday.com",
  "myworkdayjobs.com",
  "ashbyhq.com",
  "smartrecruiters.com",
  "icims.com",
  "jobvite.com",
  "workable.com",
] as const;

export const RECRUITING_SENDER_DOMAINS = [
  ...TRUSTED_ATS_DOMAINS,
  "workablemail.com",
  "taleo.net",
  "successfactors.com",
  "successfactors.eu",
  "bamboohr.com",
  "applytojob.com",
  "jazzhr.com",
  "recruitee.com",
  "teamtailor.com",
  "teamtailor-mail.com",
  "breezy.hr",
  "pinpointhq.com",
  "comeet.co",
  "hireology.com",
  "eightfold.ai",
  "avature.net",
  "brassring.com",
  "phenompeople.com",
  "jobadder.com",
  "hackerrank.com",
  "hackerrankforwork.com",
  "codility.com",
  "codesignal.com",
  "karat.io",
  "karat.com",
  "hirevue.com",
  "testgorilla.com",
  "coderbyte.com",
  "modernhire.com",
  "wellfound.com",
] as const;

function domainMatcher(domains: readonly string[]): RegExp {
  const alternatives = domains.map((d) => d.replace(/[.-]/g, "\\$&")).join("|");
  return new RegExp(`(?:^|\\.)(?:${alternatives})$`, "i");
}

const TRUSTED = domainMatcher(TRUSTED_ATS_DOMAINS);
const RECRUITING = domainMatcher(RECRUITING_SENDER_DOMAINS);

export const isTrustedAtsDomain = (domain: string): boolean =>
  !!domain && TRUSTED.test(domain);
export const isRecruitingSenderDomain = (domain: string): boolean =>
  !!domain && RECRUITING.test(domain);

/** Domain of the (last) address in a From header value, lower-cased. */
export function senderDomain(from: string): string {
  const angle = /<[^<>@\s]+@([A-Za-z0-9.-]+)>\s*$/.exec(from);
  const bare = /([^\s<>"@]+)@([A-Za-z0-9.-]+)\s*$/.exec(from);
  return (angle?.[1] ?? bare?.[2] ?? "").toLowerCase().replace(/\.$/, "");
}
