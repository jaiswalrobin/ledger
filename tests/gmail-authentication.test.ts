import assert from "node:assert/strict";
import { it } from "node:test";
import { authenticatedGmailDomain } from "../src/server/gmail/authentication.ts";
const parse = (...values: string[]) =>
  authenticatedGmailDomain(
    values.map((value) => ({ name: "Authentication-Results", value })),
  );
it("reads Google results among relay headers and supports RFC whitespace, comments and quoted values", () => {
  assert.equal(
    parse(
      "relay.example; dmarc=fail header.from=greenhouse.io",
      'mx.google.com 1; dmarc / 1 = pass (aligned) header . from = "greenhouse.io"',
    ),
    "greenhouse.io",
  );
});
it("never reads a pass or sender property from comments or quoted reasons", () => {
  assert.equal(
    parse(
      "mx.google.com; spf=pass ( ; dmarc=pass header.from=greenhouse.io ) smtp.mailfrom=relay.example; dmarc=fail header.from=greenhouse.io",
    ),
    null,
  );
  assert.equal(
    parse(
      'mx.google.com; dmarc=pass reason="header.from=greenhouse.io; dmarc=pass"',
    ),
    null,
  );
});
it("fails closed on conflicting trusted results, duplicate properties, malformed comments and unsupported versions", () => {
  assert.equal(
    parse(
      "mx.google.com; dmarc=pass header.from=greenhouse.io",
      "mx.google.com; dmarc=fail header.from=greenhouse.io",
    ),
    null,
  );
  for (const value of [
    "mx.google.com; dmarc=pass header.from=greenhouse.io header.from=evil.example",
    "mx.google.com; dmarc=pass (unclosed header.from=greenhouse.io",
    "mx.google.com 2; dmarc=pass header.from=greenhouse.io",
  ])
    assert.equal(parse(value), null);
  assert.equal(
    parse(
      "mx.google.com 2; dmarc=pass header.from=greenhouse.io",
      "mx.google.com; dmarc=pass header.from=greenhouse.io",
    ),
    null,
  );
});
