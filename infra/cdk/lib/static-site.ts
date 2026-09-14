/**
 * A static single-page app on S3 + CloudFront (docs/ARCHITECTURE.md §4.1–4.2).
 *
 * Private bucket reached only through CloudFront Origin Access Control; SPA
 * routing (403/404 -> index.html) so client-side routes resolve; HTTPS enforced.
 * Built assets are uploaded by CI (`aws s3 sync apps/<app>/dist s3://<bucket>`);
 * we don't BucketDeployment here because the apps aren't built in this repo yet.
 */
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { Bucket, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import {
  Distribution,
  Function,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
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

    const headers = new ResponseHeadersPolicy(this, "Headers", {
      securityHeadersBehavior: {
        // MUST live here and not in `customHeaders`. CloudFront classifies
        // content-security-policy as a security header and rejects it in
        // CustomHeaders outright:
        //   "The parameter CustomHeaders contains content-security-policy that
        //    is a security header and cannot be set as custom header."
        // That is a synth-clean, deploy-time 400 — it took a full stack
        // rollback to surface. Holding a CloudFormation token is not a reason
        // to move it: this field is typed `string`, and a token IS a string.
        contentSecurityPolicy: {
          contentSecurityPolicy: buildCsp(props.connectOrigins ?? []),
          override: true,
        },
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

    // `defaultRootObject` only applies to the distribution ROOT, so a request
    // for a directory — `/signup/` — asks S3 for a key that does not exist, and
    // the 404 mapping below answers it with the ROOT `/index.html`. On a bucket
    // holding one app that is invisible. On this one it served subscriber-web's
    // shell at public-web's URL: the wrong application, with a 200.
    //
    // Appending `index.html` in a viewer-request function fixes it at the only
    // point that can, because it happens BEFORE the origin lookup that would
    // otherwise miss. Deep client-side routes still 404 into the SPA fallback as
    // intended — they have no trailing slash and no extension, so they are left
    // alone here.
    const directoryIndex = new Function(this, "DirectoryIndex", {
      runtime: FunctionRuntime.JS_2_0,
      comment: "Append index.html to directory URIs so subpath-hosted SPAs resolve",
      code: FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  }
  return request;
}
      `),
    });

    this.distribution = new Distribution(this, "Dist", {
      defaultRootObject: "index.html",
      webAclId: props.webAclId,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        functionAssociations: [
          { function: directoryIndex, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      // 404 ONLY (#202). Mapping 403 → 200 meant every WAF-blocked request was
      // answered `200 OK` with the app's own HTML: the block still happened, but
      // scanners, uptime monitors and anything reading WAF metrics all saw
      // success — an edge control that works and reports that it does not.
      //
      // 403 was mapped because S3 returns it for a missing key when the caller
      // cannot list the bucket, so an unknown SPA route 403'd instead of 404'ing
      // and client-side routing broke. The fix is below: grant `s3:ListBucket`
      // to the distribution so S3 answers 404 for a missing key and the mapping
      // can be narrowed to the status that actually means "no such route".
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    // Lets S3 distinguish "missing key" (404) from "not allowed" (403) for this
    // distribution only — scoped by the source-ARN condition, so nothing else
    // gains the ability to enumerate the bucket.
    this.bucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [this.bucket.bucketArn],
        principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
        conditions: {
          StringEquals: {
            "AWS:SourceArn": Stack.of(this).formatArn({
              service: "cloudfront",
              region: "",
              resource: "distribution",
              resourceName: this.distribution.distributionId,
            }),
          },
        },
      }),
    );
  }
}
