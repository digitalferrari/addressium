-- addressium reporting read-model — example Athena queries (docs/ARCHITECTURE.md §4.23)
--
-- These run against the Glue `events` table fed by the analytics pipeline
-- (Kinesis -> Firehose -> S3, partition-projected by org_id + event_date). No
-- MSCK/crawler is needed — partition projection resolves partitions at query
-- time. Set the workgroup to `addressium-<stage>` so results land in the
-- analytics bucket. Replace `addressium_prod`, `ORG`, and the campaign lists.
--
-- A note on "opened": Apple Mail Privacy Protection auto-opens messages, so open
-- counts are inflated and unreliable. Every headline query below uses CLICKS as
-- the engagement signal; an open-based variant is included only for comparison.

-- ============================================================================
-- Q1. How many subscribers engaged with at least K of the last N editions?
--     ("How many opened the last 15 of our daily emails" — click-based.)
--     Paste your last-N campaign ids into the IN list; set the K threshold.
-- ============================================================================
SELECT count(*) AS subscribers_meeting_threshold
FROM (
  SELECT subscriber_id, count(DISTINCT campaign_id) AS editions_engaged
  FROM addressium_prod.events
  WHERE org_id = 'ORG'
    AND event_type = 'click'
    AND campaign_id IN (
      'ledger-jul06','ledger-jul07','ledger-jul08','ledger-jul09','ledger-jul10',
      'ledger-jul11','ledger-jul12','ledger-jul13','ledger-jul14','ledger-jul15',
      'ledger-jul16','ledger-jul17','ledger-jul18','ledger-jul19','ledger-jul20'
    )
  GROUP BY subscriber_id
) t
WHERE editions_engaged >= 8;   -- K of N

-- ============================================================================
-- Q2. Full engagement histogram over the same N editions:
--     how many subscribers engaged with exactly 0,1,2,…,N of them.
-- ============================================================================
SELECT editions_engaged, count(*) AS subscribers
FROM (
  SELECT subscriber_id, count(DISTINCT campaign_id) AS editions_engaged
  FROM addressium_prod.events
  WHERE org_id = 'ORG'
    AND event_type = 'click'
    AND campaign_id IN ( /* … last N campaign ids … */ )
  GROUP BY subscriber_id
) t
GROUP BY editions_engaged
ORDER BY editions_engaged;

-- ============================================================================
-- Q3. Per-campaign funnel for a date range (sent → delivered → opened → clicked),
--     unique subscribers per stage. Partition pruning on event_date keeps scans small.
-- ============================================================================
SELECT campaign_id,
       count(DISTINCT CASE WHEN event_type = 'sent'      THEN subscriber_id END) AS sent,
       count(DISTINCT CASE WHEN event_type = 'delivered' THEN subscriber_id END) AS delivered,
       count(DISTINCT CASE WHEN event_type = 'open'      THEN subscriber_id END) AS opened_mpp_inflated,
       count(DISTINCT CASE WHEN event_type = 'click'     THEN subscriber_id END) AS clicked
FROM addressium_prod.events
WHERE org_id = 'ORG'
  AND event_date BETWEEN '2026-07-01' AND '2026-07-20'
GROUP BY campaign_id
ORDER BY campaign_id;

-- ============================================================================
-- Q4. One subscriber's full cross-campaign history (per-user drilldown).
-- ============================================================================
SELECT event_date, campaign_id, event_type, link_id, at
FROM addressium_prod.events
WHERE org_id = 'ORG'
  AND subscriber_id = 'SUBSCRIBER_ID'
ORDER BY at DESC;

-- ============================================================================
-- Q5. Open-based variant of Q1 — for comparison ONLY. Expect this to over-count
--     vs. Q1 because MPP fires opens with no human involved.
-- ============================================================================
SELECT count(*) AS subscribers_meeting_threshold_by_open
FROM (
  SELECT subscriber_id, count(DISTINCT campaign_id) AS editions_opened
  FROM addressium_prod.events
  WHERE org_id = 'ORG'
    AND event_type = 'open'
    AND campaign_id IN ( /* … last N campaign ids … */ )
  GROUP BY subscriber_id
) t
WHERE editions_opened >= 8;
