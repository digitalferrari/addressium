/**
 * A static single-page app on S3 + CloudFront (docs/ARCHITECTURE.md §4.1–4.2).
 *
 * Private bucket reached only through CloudFront Origin Access Control; SPA
 * routing (403/404 -> index.html) so client-side routes resolve; HTTPS enforced.
 * Built assets are uploaded by CI (`aws s3 sync apps/<app>/dist s3://<bucket>`);
 * we don't BucketDeployment here because the apps aren't built in this repo yet.
 */
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Bucket, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import {
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";

export interface StaticSiteProps {
  prod: boolean;
  /** CLOUDFRONT-scope WAF WebACL ARN to attach to the distribution (§5, #20). */
  webAclId?: string;
  /**
   * Origins this SPA is allowed to `fetch` (its API, its Cognito Hosted UI).
   * They can't be hardcoded here: both are CloudFormation tokens resolved at
   * synth. Anything not listed is blocked by `connect-src`, which is the point —
   * an injected script cannot post the operator's tokens to its own collector.
   */
  connectOrigins?: string[];
}

/**
 * The Content-Security-Policy both SPAs ship (#197).
 *
 * The admin console renders operator-authored HTML in a GrapesJS editor and in a
 * `srcdoc` preview iframe, which inherits this policy — so `script-src 'self'`
 * is what stops a pasted `<script>` in a template from running with the console's
 * tokens in reach. The looser directives are load-bearing, not laziness:
 *
 * - `style-src 'unsafe-inline'` — GrapesJS writes inline styles as the operator
 *   drags blocks, and email HTML is inline-styled by definition. There is no
 *   nonce path through a static S3 origin.
 * - `img-src https:` — editorial images come from the publisher's own CDN, which
 *   we don't know at synth.
 * - `frame-src 'self'` — the template preview is an `about:srcdoc` frame.
 *
 * `frame-ancestors 'none'` and `base-uri 'none'` are the cheap wins: no
 * clickjacking, and an injected `<base>` can't repoint every relative script url
 * at an attacker's host.
 */
function buildCsp(connectOrigins: string[]): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${["'self'", ...connectOrigins].join(" ")}`,
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export class StaticSite extends Construct {
  public readonly bucket: Bucket;
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: StaticSiteProps) {
    super(scope, id);

    this.bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: props.prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !props.prod,
    });

    // CSP is set as a custom header rather than through `contentSecurityPolicy`
    // in `securityHeadersBehavior`, because the policy string contains
    // CloudFormation tokens (the API and Hosted-UI origins) and the L2 typing
    // for that field is identical in effect.
    const headers = new ResponseHeadersPolicy(this, "Headers", {
      securityHeadersBehavior: {
        // Two years, preloadable. The SPA is HTTPS-only already; HSTS is what
        // stops the FIRST request of a session from being downgraded.
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          // A magic-link or OAuth callback URL must never leak in a Referer.
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "content-security-policy",
            value: buildCsp(props.connectOrigins ?? []),
            override: true,
          },
          // Neither SPA uses any of these, and an injected script inheriting a
          // permission the page never asked for is free reach.
          {
            header: "permissions-policy",
            value:
              "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
            override: true,
          },
        ],
      },
    });

    this.distribution = new Distribution(this, "Dist", {
      defaultRootObject: "index.html",
      webAclId: props.webAclId,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });
  }
}
