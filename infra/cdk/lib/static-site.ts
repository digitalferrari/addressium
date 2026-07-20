/**
 * A static single-page app on S3 + CloudFront (docs/ARCHITECTURE.md §4.1–4.2).
 *
 * Private bucket reached only through CloudFront Origin Access Control; SPA
 * routing (403/404 -> index.html) so client-side routes resolve; HTTPS enforced.
 * Built assets are uploaded by CI (`aws s3 sync apps/<app>/dist s3://<bucket>`);
 * we don't BucketDeployment here because the apps aren't built in this repo yet.
 */
import { RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Bucket, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
import { Distribution, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";

export interface StaticSiteProps {
  prod: boolean;
  /** CLOUDFRONT-scope WAF WebACL ARN to attach to the distribution (§5, #20). */
  webAclId?: string;
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

    this.distribution = new Distribution(this, "Dist", {
      defaultRootObject: "index.html",
      webAclId: props.webAclId,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });
  }
}
