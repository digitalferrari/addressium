/**
 * REFERENCE WebACLs for the public edge (docs/DEPLOYMENT.md §8, #188, #225).
 *
 * **Nothing in this stack calls these.** addressium deliberately creates no
 * WebACL: a resource carries exactly one, so ours would displace the operator's
 * and the next `cdk deploy` would silently put ours back (#225). The operator
 * creates their own and passes its ARN as `apiWebAclArn` / `cloudfrontWebAclArn`.
 *
 * This file exists so that "create your own" is not a blank page. It is the
 * configuration addressium is actually tested against, exported so an operator
 * can import it into their own CDK app, or read it and reproduce the rules by
 * hand in the console. The rules here encode four things that are not obvious
 * and that break this application if you get them wrong — each is commented at
 * the point it matters, because a runbook paragraph nobody reads is how #188
 * happened in the first place.
 */
import { Construct } from "constructs";
import { CfnWebACL, CfnLoggingConfiguration } from "aws-cdk-lib/aws-wafv2";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { RemovalPolicy } from "aws-cdk-lib";

/**
 * The admin routes whose bodies legitimately carry an entire HTML email.
 *
 * Saving a campaign or a template posts a full email body. Real HTML emails
 * routinely exceed 8 KB and are, by definition, made of markup — so the AWS
 * managed rules that check body size and look for script-like content both fire
 * on exactly the two requests the console cannot work without.
 */
export const HTML_BODY_ROUTES = ["/campaigns", "/templates", "/campaigns/schedule"] as const;

/**
 * WAF inspects at most 8 KB of a request body, which is why
 * `SizeRestrictions_BODY` blocks anything larger: it cannot see the rest.
 */
const WAF_BODY_INSPECTION_LIMIT = 8192;

/**
 * Path transformations applied before every URI match.
 *
 * `LOWERCASE` alone was not enough (#188): without `URL_DECODE` a request to
 * `/%73ignup` never matched, and without `NORMALIZE_PATH` neither did
 * `/foo/../signup`. Both are the standard encoded-path evasions, and a CAPTCHA
 * rule that any scripted client can step around by percent-encoding one
 * character is decoration.
 */
const PATH_TRANSFORMS = [
  { priority: 0, type: "URL_DECODE" },
  { priority: 1, type: "NORMALIZE_PATH" },
  { priority: 2, type: "LOWERCASE" },
];

const uriPath = (
  searchString: string,
  positionalConstraint: "EXACTLY" | "STARTS_WITH",
): CfnWebACL.StatementProperty => ({
  byteMatchStatement: {
    fieldToMatch: { uriPath: {} },
    positionalConstraint,
    searchString,
    textTransformations: PATH_TRANSFORMS,
  },
});

const isPost: CfnWebACL.StatementProperty = {
  byteMatchStatement: {
    fieldToMatch: { method: {} },
    positionalConstraint: "EXACTLY",
    searchString: "POST",
    textTransformations: [{ priority: 0, type: "UPPERCASE" }],
  },
};

const visibility = (metricName: string) => ({
  sampledRequestsEnabled: true,
  cloudWatchMetricsEnabled: true,
  metricName,
});

/**
 * The AWS common rule set, with the two rules this application cannot live under
 * set to COUNT rather than BLOCK (#188).
 *
 * `overrideAction: { none: {} }` with no exclusions is what broke campaign and
 * template saving: `SizeRestrictions_BODY` blocks bodies over 8 KB, and
 * `CrossSiteScripting_BODY` blocks bodies containing markup — which is precisely
 * what an email template *is*.
 *
 * COUNT, not removed. The rules keep emitting metrics and sampled requests, so
 * an operator can still see what they would have blocked and tune from evidence
 * rather than from guesswork. Body size is then re-enforced below by a rule that
 * knows which routes are allowed to be large.
 *
 * The honest consequence: on those routes the body is **not** WAF-inspected. The
 * controls that remain are the application's — zod validation at the boundary,
 * `sanitizeEmailHtml` on raw HTML, and the CSP on the rendered output. That is a
 * deliberate trade, not an oversight: the alternative is a console that cannot
 * save a newsletter.
 */
const commonRuleSet = (priority: number, withHtmlExceptions: boolean): CfnWebACL.RuleProperty => ({
  name: "AWSManagedRulesCommonRuleSet",
  priority,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: "AWS",
      name: "AWSManagedRulesCommonRuleSet",
      ...(withHtmlExceptions
        ? {
            ruleActionOverrides: [
              { name: "SizeRestrictions_BODY", actionToUse: { count: {} } },
              { name: "CrossSiteScripting_BODY", actionToUse: { count: {} } },
            ],
          }
        : {}),
    },
  },
  visibilityConfig: visibility("AWSManagedRulesCommonRuleSet"),
});

const knownBadInputs = (priority: number): CfnWebACL.RuleProperty => ({
  name: "AWSManagedRulesKnownBadInputsRuleSet",
  priority,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: "AWS",
      name: "AWSManagedRulesKnownBadInputsRuleSet",
    },
  },
  visibilityConfig: visibility("AWSManagedRulesKnownBadInputsRuleSet"),
});

/**
 * Re-block oversized bodies everywhere EXCEPT the routes that carry email HTML
 * (#188).
 *
 * Setting `SizeRestrictions_BODY` to COUNT above turns it off for every route,
 * including the unauthenticated ones where a multi-megabyte body is pure
 * denial-of-wallet. This puts the protection back with the one exception the
 * application actually needs, rather than leaving a hole the width of the API.
 */
const oversizeBodyOutsideHtmlRoutes = (priority: number): CfnWebACL.RuleProperty => ({
  name: "OversizeBodyOutsideHtmlRoutes",
  priority,
  action: { block: {} },
  statement: {
    andStatement: {
      statements: [
        {
          sizeConstraintStatement: {
            fieldToMatch: { body: { oversizeHandling: "MATCH" } },
            comparisonOperator: "GT",
            size: WAF_BODY_INSPECTION_LIMIT,
            textTransformations: [{ priority: 0, type: "NONE" }],
          },
        },
        {
          notStatement: {
            statement: {
              orStatement: {
                statements: HTML_BODY_ROUTES.map((r) => uriPath(r, "EXACTLY")),
              },
            },
          },
        },
      ],
    },
  },
  visibilityConfig: visibility("OversizeBodyOutsideHtmlRoutes"),
});

/** Blunt per-IP ceiling across the whole surface. */
const rateRule = (priority: number, limit = 2000): CfnWebACL.RuleProperty => ({
  name: "RateLimitPerIp",
  priority,
  action: { block: {} },
  statement: { rateBasedStatement: { limit, aggregateKeyType: "IP" } },
  visibilityConfig: visibility("RateLimitPerIp"),
});

/**
 * A much tighter ceiling on signup specifically (#188).
 *
 * The global 2000-per-5-minutes rule permits 2000 signups per IP per 5 minutes,
 * which is not a brake on the list-bombing and enumeration threat this file's
 * own header names — it is a brake on a different, much larger problem. Signup
 * is the route that costs money when abused: every submission sends real mail to
 * an attacker-chosen address, burning the org's own SES reputation.
 *
 * 20 per 5 minutes is generous for a human and ruinous for a script. WAF's
 * minimum rate-limit window is 5 minutes and its floor is 100, so the scope-down
 * to signup paths is what makes a meaningful number expressible at all.
 */
const signupRateRule = (priority: number, limit = 100): CfnWebACL.RuleProperty => ({
  name: "SignupRateLimitPerIp",
  priority,
  action: { block: {} },
  statement: {
    rateBasedStatement: {
      limit,
      aggregateKeyType: "IP",
      scopeDownStatement: uriPath("/signup", "STARTS_WITH"),
    },
  },
  visibilityConfig: visibility("SignupRateLimitPerIp"),
});

/**
 * CAPTCHA on `POST /signup` — and NOT on `/signup/batch` (#188).
 *
 * The old rule matched `STARTS_WITH "/signup"`, which also caught
 * `/signup/batch`. That route is called by the subscriber site's "all
 * newsletters" page rather than typed by a person, and a CAPTCHA challenge to a
 * non-browser client is simply a broken endpoint. `EXACTLY` is the fix, and it
 * is why the rate rule above uses `STARTS_WITH` while this one does not — the
 * two rules want different scopes and previously shared a wrong one.
 */
const signupCaptcha = (priority: number): CfnWebACL.RuleProperty => ({
  name: "SignupCaptcha",
  priority,
  action: { captcha: {} },
  statement: {
    andStatement: { statements: [uriPath("/signup", "EXACTLY"), isPost] },
  },
  visibilityConfig: visibility("SignupCaptcha"),
});

/**
 * Turn on WAF logging (#188).
 *
 * Neither ACL had a `CfnLoggingConfiguration`, so there was no way to see what
 * was blocked, no abuse forensics, and no evidence to tune a rule from. A WAF
 * that blocks template saving with no log is indistinguishable from a broken
 * deploy — which is the shape #188's own defects would have taken in production.
 *
 * The log group name MUST begin with `aws-waf-logs-`; WAF rejects any other
 * destination. Authorization headers are redacted: a WAF log is a request log,
 * and a request log containing bearer tokens is a credential store.
 */
function addLogging(scope: Construct, id: string, acl: CfnWebACL): void {
  const group = new LogGroup(scope, `${id}Logs`, {
    logGroupName: `aws-waf-logs-addressium-${id.toLowerCase()}`,
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  new CfnLoggingConfiguration(scope, `${id}Logging`, {
    resourceArn: acl.attrArn,
    logDestinationConfigs: [group.logGroupArn],
    redactedFields: [{ singleHeader: { Name: "authorization" } }],
  });
}

/**
 * REGIONAL ACL for the HTTP API stage.
 *
 * Rule order is load-bearing. The oversize-body rule sits BEFORE the managed
 * sets so a large body is rejected without being handed to them, and the CAPTCHA
 * sits last so a request that has already failed a managed rule is blocked
 * outright rather than being offered a puzzle.
 */
export function makeRegionalWebAcl(scope: Construct, id: string): CfnWebACL {
  const acl = new CfnWebACL(scope, id, {
    scope: "REGIONAL",
    defaultAction: { allow: {} },
    rules: [
      oversizeBodyOutsideHtmlRoutes(1),
      commonRuleSet(2, true),
      knownBadInputs(3),
      rateRule(4),
      signupRateRule(5),
      signupCaptcha(6),
    ],
    visibilityConfig: visibility(`${id}Metric`),
  });
  addLogging(scope, id, acl);
  return acl;
}

/**
 * CLOUDFRONT ACL for the SPA distributions. Must be created in `us-east-1`
 * whatever region the stack lives in.
 *
 * No HTML-body exceptions here, and that is deliberate: these distributions
 * serve static built assets and take no request bodies at all, so the managed
 * rules have nothing legitimate to break. The exception exists only where the
 * application genuinely posts markup, which is the API.
 */
export function makeCloudFrontWebAcl(scope: Construct, id: string): CfnWebACL {
  const acl = new CfnWebACL(scope, id, {
    scope: "CLOUDFRONT",
    defaultAction: { allow: {} },
    rules: [commonRuleSet(1, false), knownBadInputs(2), rateRule(3)],
    visibilityConfig: visibility(`${id}Metric`),
  });
  addLogging(scope, id, acl);
  return acl;
}
