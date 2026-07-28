export interface HttpEvent {
    body?: string | null;
    headers?: Record<string, string | undefined>;
    pathParameters?: Record<string, string | undefined> | null;
    queryStringParameters?: Record<string, string | undefined> | null;
    requestContext?: {
        /** "METHOD /path" as registered in API Gateway; drives router dispatch. */
        routeKey?: string;
        http?: {
            method?: string;
        };
        authorizer?: {
            jwt?: {
                claims?: Record<string, string | undefined>;
            };
        };
    };
}
export interface HttpResult {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}
/** POST /signup — public, double opt-in (§4.2). */
export declare function signupHandler(event: HttpEvent): Promise<HttpResult>;
/**
 * POST /signup/batch — opt into several lists at once (the "All newsletters"
 * page, #61). Unauthenticated like /signup; one double opt-in email covers all.
 */
export declare function signupBatchHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /confirm?token=... — double opt-in landing; confirms every list in the token (§4.2). */
export declare function confirmHandler(event: HttpEvent): Promise<HttpResult>;
/** POST /campaigns/schedule — send now, at a time, or recurring (§4.6, §4.16). */
export declare function scheduleCampaignHandler(event: HttpEvent): Promise<HttpResult>;
/**
 * POST /campaigns/lifecycle — start (resume), pause, or archive a scheduled send
 * (§4.6). Never deletes: pause/archive flip the lifecycle record, and the launch
 * handler (recurring) and sender (one-off) gate on it, so a paused series stops
 * its next edition and can be resumed later.
 */
export declare function scheduleLifecycleHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /orgs/{org}/schedules — lifecycle records for the console's Schedules view. */
export declare function schedulesListHandler(event: HttpEvent): Promise<HttpResult>;
/** POST /unsubscribe?token=... — RFC 8058 one-click, no login (§4.2). */
export declare function unsubscribeHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /orgs/{org}/lists — list newsletters. POST — create/edit one. */
export declare function listsHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /orgs/{org} — lightweight org metadata (name, environment) for the console header. */
export declare function orgMetaHandler(event: HttpEvent): Promise<HttpResult>;
/**
 * GET /version — what is actually deployed.
 *
 * Public and unauthenticated by design: it reports only the release and schema
 * version, never configuration or secrets. An operator needs to answer "did my
 * upgrade land?" without reading CloudFormation, and the upgrade rehearsal
 * (#213) asserts on it before and after a deploy.
 *
 * `deployed` is the marker last written to the table; `running` is the version
 * of the code answering this request. They differ mid-deploy, and a persistent
 * mismatch means the marker write failed — which is worth seeing.
 */
export declare function versionHandler(): Promise<HttpResult>;
/** GET /orgs/{org}/setup — onboarding checklist state for the setup wizard (§9). */
export declare function setupStateHandler(event: HttpEvent): Promise<HttpResult>;
/** POST /lists/visibility — open (reopen) or close a newsletter (destructive). */
export declare function listVisibilityHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /orgs/{org}/campaigns/{id} — read draft. POST /campaigns — save draft. */
export declare function campaignsHandler(event: HttpEvent): Promise<HttpResult>;
/**
 * GET /orgs/{org}/campaigns — recent campaigns for the console's report picker
 * (#103). Returns a lightweight projection (no full template bodies), newest by
 * campaignId first, so operators don't have to remember raw ids.
 */
export declare function campaignsListHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /orgs/{org}/templates — list. GET …/templates/{id} — one. POST /templates — save. */
export declare function templatesHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /orgs/{org}/segments — list. POST /segments — create/edit one. */
export declare function segmentsHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /orgs/{org}/drip-sequences — list. POST /drip-sequences — create/edit (#104). */
export declare function dripSequencesHandler(event: HttpEvent): Promise<HttpResult>;
/** POST /subscribers/suppress — manual suppression (admin). */
export declare function subscriberSuppressHandler(event: HttpEvent): Promise<HttpResult>;
/**
 * GET /orgs/{org}/subscribers — subscriber lookup/list for the admin console
 * (#102). Optional `?q=` filters by email substring. Returns a projection (no
 * raw attributes bag) so the table stays light. Paginated at the adapter layer.
 */
export declare function subscribersListHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /orgs/{org}/suppressions — org-scoped suppression list for review (#102). */
export declare function suppressionsListHandler(event: HttpEvent): Promise<HttpResult>;
/** POST /subscribers/unsuppress — lift an org suppression + reactivate (#102). */
export declare function subscriberUnsuppressHandler(event: HttpEvent): Promise<HttpResult>;
/**
 * POST /orgs/{org}/import — CSV/Pinpoint subscriber migration (#100). Accepts a
 * CSV body (header + rows); `dryRun` reports counts without writing. Imported
 * subscribers default to `pending` (not double-opt-in confirmed) unless the
 * caller sets status; suppressed addresses are skipped by the domain importer.
 */
export declare function importHandler(event: HttpEvent): Promise<HttpResult>;
/**
 * POST /privacy — GDPR/CCPA data-subject request (#101). `export` returns the
 * person's record (requires subscribers:manage); `erase` anonymizes + suppresses
 * (requires the stronger subscribers:delete). Sensitive; admin-invoked only.
 */
export declare function privacyHandler(event: HttpEvent): Promise<HttpResult>;
/** POST /subscribers/unsubscribe — admin-initiated unsubscribe (one list or all). */
export declare function subscriberUnsubscribeHandler(event: HttpEvent): Promise<HttpResult>;
/** POST /orgs/branding — set subscriber-site branding/theme (#31). GET is public. */
export declare function brandingHandler(event: HttpEvent): Promise<HttpResult>;
/** POST /lists/presentation — set a list's subscriber-site toggles (#33). */
export declare function listPresentationHandler(event: HttpEvent): Promise<HttpResult>;
/** GET /orgs/{org}/lists/{list}/public — public list view honoring toggles (#33). */
export declare function publicListHandler(event: HttpEvent): Promise<HttpResult>;
/**
 * POST /orgs/ai-config — set the org's LLM analytics provider (#32). The
 * plaintext API key is written to Secrets Manager here; only the ARN + vendor/
 * model are persisted on the org. Gated by identity:manage.
 */
export declare function aiConfigHandler(event: HttpEvent): Promise<HttpResult>;
/** POST /webhooks/entitlement — signed webhook from the billing SoR (§4.3). */
export declare function entitlementSyncHandler(event: HttpEvent): Promise<HttpResult>;
/**
 * POST /webhooks/identity — signed webhook from the main user pool / SoR (§4.3).
 * Applies add / email-change / delete keyed by the immutable Cognito `sub`.
 * One-directional: addressium never writes back to the pool.
 */
export declare function identitySyncHandler(event: HttpEvent): Promise<HttpResult>;
export declare const adminRouter: (event: HttpEvent) => Promise<HttpResult>;
export declare const publicRouter: (event: HttpEvent) => Promise<HttpResult>;
/** Exported so the route-parity test can assert against the CDK route list. */
export declare const ROUTE_KEYS: {
    admin: string[];
    public: string[];
};
