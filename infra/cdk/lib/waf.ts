/**
 * AWS WAF WebACLs for the public edge (docs/SECURITY.md §5, §4.4, #20).
 *
 * Two ACLs because scope differs: REGIONAL for the API Gateway HTTP API stage,
 * CLOUDFRONT for the SPA distributions (CLOUDFRONT ACLs must live in us-east-1).
 * Both carry the AWS managed common + known-bad-inputs rule sets and a per-IP
 * rate-based rule. The regional ACL adds a CAPTCHA challenge on the unauthenticated
 * signup path to blunt automated list-bombing.
 */
import { Construct } from "constructs";
import { CfnWebACL } from "aws-cdk-lib/aws-wafv2";

const managed = (name: string, priority: number, vendor = "AWS"): CfnWebACL.RuleProperty => ({
  name: `${name}`,
  priority,
  overrideAction: { none: {} },
  statement: { managedRuleGroupStatement: { vendorName: vendor, name } },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: name,
  },
});

const rateRule = (priority: number, limit = 2000): CfnWebACL.RuleProperty => ({
  name: "RateLimitPerIp",
  priority,
  action: { block: {} },
  statement: { rateBasedStatement: { limit, aggregateKeyType: "IP" } },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "RateLimitPerIp",
  },
});

/** CAPTCHA on POST /signup — soft challenge for the unauthenticated signup. */
const signupCaptcha = (priority: number): CfnWebACL.RuleProperty => ({
  name: "SignupCaptcha",
  priority,
  action: { captcha: {} },
  statement: {
    andStatement: {
      statements: [
        {
          byteMatchStatement: {
            fieldToMatch: { uriPath: {} },
            positionalConstraint: "STARTS_WITH",
            searchString: "/signup",
            textTransformations: [{ priority: 0, type: "LOWERCASE" }],
          },
        },
        {
          byteMatchStatement: {
            fieldToMatch: { method: {} },
            positionalConstraint: "EXACTLY",
            searchString: "POST",
            textTransformations: [{ priority: 0, type: "UPPERCASE" }],
          },
        },
      ],
    },
  },
  visibilityConfig: {
    sampledRequestsEnabled: true,
    cloudWatchMetricsEnabled: true,
    metricName: "SignupCaptcha",
  },
});

function baseRules(): CfnWebACL.RuleProperty[] {
  return [
    managed("AWSManagedRulesCommonRuleSet", 1),
    managed("AWSManagedRulesKnownBadInputsRuleSet", 2),
    rateRule(3),
  ];
}

/** REGIONAL ACL for the HTTP API stage — base rules + signup CAPTCHA. */
export function makeRegionalWebAcl(scope: Construct, id: string): CfnWebACL {
  return new CfnWebACL(scope, id, {
    scope: "REGIONAL",
    defaultAction: { allow: {} },
    rules: [...baseRules(), signupCaptcha(4)],
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: `${id}Metric`,
    },
  });
}

/** CLOUDFRONT ACL for the SPA distributions — base rules only. */
export function makeCloudFrontWebAcl(scope: Construct, id: string): CfnWebACL {
  return new CfnWebACL(scope, id, {
    scope: "CLOUDFRONT",
    defaultAction: { allow: {} },
    rules: baseRules(),
    visibilityConfig: {
      sampledRequestsEnabled: true,
      cloudWatchMetricsEnabled: true,
      metricName: `${id}Metric`,
    },
  });
}
