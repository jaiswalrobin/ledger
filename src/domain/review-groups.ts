/**
 * Groups open reviews that are probably about the same job, so eight emails from one interview
 * thread read as one decision. Grouping is presentation only: each email is still resolved on
 * its own, and resolving one re-checks the others under the normal rules.
 */
import { companyKey, normalizedText } from "./normalization.ts";

export interface GroupableReview {
  id: string;
  company: string | null;
  title: string | null;
  /** The sender's domain, for emails that name no company. */
  senderDomain: string | null;
}

/**
 * Review ids in groups, keeping the input order within and between groups (a group sits where
 * its first member was). An email joins a group when it names the same company and title, the
 * same company as a group that names only one title, or, naming no company, comes from a domain
 * already in exactly one group.
 */
export function groupReviews(reviews: readonly GroupableReview[]): string[][] {
  interface Group {
    ids: string[];
    company: string | null;
    titles: Set<string>;
    domains: Set<string>;
  }
  const groups: Group[] = [];
  const unique = <T>(matches: T[]): T | null =>
    matches.length === 1 ? matches[0]! : null;

  for (const review of reviews) {
    const company = review.company ? companyKey(review.company) : null;
    const title = review.title ? normalizedText(review.title) : null;
    const domain = review.senderDomain?.toLowerCase() ?? null;
    const sameCompany = company
      ? groups.filter((g) => g.company === company)
      : [];
    const group = company
      ? title
        ? (sameCompany.find((g) => g.titles.has(title)) ??
          unique(sameCompany.filter((g) => g.titles.size === 0)))
        : unique(sameCompany.filter((g) => g.titles.size <= 1))
      : domain
        ? unique(groups.filter((g) => g.domains.has(domain)))
        : null;
    if (group) {
      group.ids.push(review.id);
      if (title) group.titles.add(title);
      if (domain) group.domains.add(domain);
      if (company && !group.company) group.company = company;
    } else
      groups.push({
        ids: [review.id],
        company,
        titles: new Set(title ? [title] : []),
        domains: new Set(domain ? [domain] : []),
      });
  }
  return groups.map((g) => g.ids);
}
