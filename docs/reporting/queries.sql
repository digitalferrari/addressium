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
--
-- ============================================================================
-- TWO RULES, both of which every query below follows (#199, #164)
-- ============================================================================
--
-- 1. ALWAYS BOUND `event_date`.
--
--    Partition projection ENUMERATES the projected range — it does not discover
--    partitions, it generates them. The range tracks the bucket's retention
--    (`analyticsEventRetentionDays`, two years by default), so a query with no
--    `event_date` predicate asks Athena to resolve ~730 prefixes per org and
--    scan every object under them. The workgroup enforces a 10 GB scan cutoff,
--    so past a modest amount of history such a query does not run slowly — it
--    FAILS. Four of the five queries in this file used to have no date bound.
--
--    Every query below therefore takes an explicit `:from_date` / `:to_date`.
--    Narrow them: the window you actually care about is almost always the N
--    editions you are asking about, not "all of history".
--
-- 2. ALWAYS ANTI-JOIN THE ERASURE TOMBSTONES.
--
--    A GDPR erasure cannot delete rows already written to S3 — they are
--    compressed, partitioned, append-only objects. Instead the erasure writes an
--    `event_type = 'erased'` row for that subscriber into this same table, and
--    the `archive-events` lifecycle rule removes their rows outright once
--    retention expires. Between those two moments, a query that does not exclude
--    erased subscribers is reporting on people who asked to be forgotten.
--
--    The `engaged` CTE below does both. Copy it; do not hand-roll the filter.

-- ============================================================================
-- Q0. The base CTE every query below builds on: one org, one date window,
--     erased subscribers removed. Not a query on its own.
-- ============================================================================
-- WITH erased AS (
--   SELECT DISTINCT subscriber_id
--   FROM addressium_prod.events
--   WHERE org_id = 'ORG'
--     AND event_type = 'erased'
--     AND event_date BETWEEN '2026-01-01' AND '2026-07-20'
-- )
--
-- The erasure window should be at least as wide as the fact window: a
-- subscriber erased in July must be excluded from January's rows too. Widening
-- it is cheap — `erased` rows are a rounding error next to engagement rows.

-- ============================================================================
-- Q1. How many subscribers engaged with at least K of the last N editions?
--     ("How many opened the last 15 of our daily emails" — click-based.)
--     Paste your last-N campaign ids into the IN list; set the K threshold.
--     Set the date window to the span those N editions were sent over.
-- ============================================================================
WITH erased AS (
  SELECT DISTINCT subscriber_id
  FROM addressium_prod.events
  WHERE org_id = 'ORG'
    AND event_type = 'erased'
    AND event_date BETWEEN '2026-07-06' AND '2026-07-27'
)
SELECT count(*) AS subscribers_meeting_threshold
FROM (
  SELECT e.subscriber_id, count(DISTINCT e.campaign_id) AS editions_engaged
  FROM addressium_prod.events e
  LEFT JOIN erased x ON x.subscriber_id = e.subscriber_id
  WHERE e.org_id = 'ORG'
    AND e.event_type = 'click'
    -- The send window for the N editions, plus a tail for late clicks.
    AND e.event_date BETWEEN '2026-07-06' AND '2026-07-27'
    AND x.subscriber_id IS NULL
    AND e.campaign_id IN (
      'ledger-jul06','ledger-jul07','ledger-jul08','ledger-jul09','ledger-jul10',
      'ledger-jul11','ledger-jul12','ledger-jul13','ledger-jul14','ledger-jul15',
      'ledger-jul16','ledger-jul17','ledger-jul18','ledger-jul19','ledger-jul20'
    )
  GROUP BY e.subscriber_id
) t
WHERE editions_engaged >= 8;   -- K of N

-- ============================================================================
-- Q2. Full engagement histogram over the same N editions:
--     how many subscribers engaged with exactly 0,1,2,…,N of them.
-- ============================================================================
WITH erased AS (
  SELECT DISTINCT subscriber_id
  FROM addressium_prod.events
  WHERE org_id = 'ORG'
    AND event_type = 'erased'
    AND event_date BETWEEN '2026-07-06' AND '2026-07-27'
)
SELECT editions_engaged, count(*) AS subscribers
FROM (
  SELECT e.subscriber_id, count(DISTINCT e.campaign_id) AS editions_engaged
  FROM addressium_prod.events e
  LEFT JOIN erased x ON x.subscriber_id = e.subscriber_id
  WHERE e.org_id = 'ORG'
    AND e.event_type = 'click'
    AND e.event_date BETWEEN '2026-07-06' AND '2026-07-27'
    AND x.subscriber_id IS NULL
    AND e.campaign_id IN ( /* … last N campaign ids … */ )
  GROUP BY e.subscriber_id
) t
GROUP BY editions_engaged
ORDER BY editions_engaged;

-- ============================================================================
-- Q3. Per-campaign funnel for a date range (sent → delivered → opened → clicked),
--     unique subscribers per stage. Partition pruning on event_date keeps scans small.
-- ============================================================================
WITH erased AS (
  SELECT DISTINCT subscriber_id
  FROM addressium_prod.events
  WHERE org_id = 'ORG'
    AND event_type = 'erased'
    AND event_date BETWEEN '2026-07-01' AND '2026-07-20'
)
SELECT e.campaign_id,
       count(DISTINCT CASE WHEN e.event_type = 'sent'      THEN e.subscriber_id END) AS sent,
       count(DISTINCT CASE WHEN e.event_type = 'delivered' THEN e.subscriber_id END) AS delivered,
       count(DISTINCT CASE WHEN e.event_type = 'open'      THEN e.subscriber_id END) AS opened_mpp_inflated,
       count(DISTINCT CASE WHEN e.event_type = 'click'     THEN e.subscriber_id END) AS clicked
FROM addressium_prod.events e
LEFT JOIN erased x ON x.subscriber_id = e.subscriber_id
WHERE e.org_id = 'ORG'
  AND e.event_date BETWEEN '2026-07-01' AND '2026-07-20'
  AND x.subscriber_id IS NULL
GROUP BY e.campaign_id
ORDER BY e.campaign_id;

-- ============================================================================
-- Q4. One subscriber's full cross-campaign history (per-user drilldown).
--
--     No anti-join here: this query is BY subscriber id, so if that subscriber
--     has been erased the right answer is zero rows, and the `erased` row itself
--     showing up in the output is the honest explanation of why. The date bound
--     is still required — without it this scans the whole retention window to
--     find one person.
-- ============================================================================
SELECT event_date, campaign_id, event_type, link_id, at
FROM addressium_prod.events
WHERE org_id = 'ORG'
  AND subscriber_id = 'SUBSCRIBER_ID'
  AND event_date BETWEEN '2026-01-01' AND '2026-07-20'
ORDER BY at DESC;

-- ============================================================================
-- Q5. Open-based variant of Q1 — for comparison ONLY. Expect this to over-count
--     vs. Q1 because MPP fires opens with no human involved.
-- ============================================================================
WITH erased AS (
  SELECT DISTINCT subscriber_id
  FROM addressium_prod.events
  WHERE org_id = 'ORG'
    AND event_type = 'erased'
    AND event_date BETWEEN '2026-07-06' AND '2026-07-27'
)
SELECT count(*) AS subscribers_meeting_threshold_by_open
FROM (
  SELECT e.subscriber_id, count(DISTINCT e.campaign_id) AS editions_opened
  FROM addressium_prod.events e
  LEFT JOIN erased x ON x.subscriber_id = e.subscriber_id
  WHERE e.org_id = 'ORG'
    AND e.event_type = 'open'
    AND e.event_date BETWEEN '2026-07-06' AND '2026-07-27'
    AND x.subscriber_id IS NULL
    AND e.campaign_id IN ( /* … last N campaign ids … */ )
  GROUP BY e.subscriber_id
) t
WHERE editions_opened >= 8;

-- ============================================================================
-- Q6. The dimension tier (#199). The nightly point-in-time export lands under
--     `entities/export_date=YYYY-MM-DD/`, catalogued as `entities`.
--
--     Two things to know before using it:
--
--     - ALWAYS pin `export_date` to ONE day. The bucket retains 30 snapshots and
--       the table spans all of them, so an unpinned query returns every row 30
--       times over.
--     - `item.pk IS NOT NULL` drops the export's own `manifest-*.json` files,
--       which sit beside the data files and parse as rows with no item.
--
--     `item.data.m` exposes the domain entity as a map of scalars. Nested
--     attributes (a subscriber's `attributes` map, say) read back NULL rather
--     than failing the query — this tier is for joins on identity and status,
--     not for reconstructing whole entities.
-- ============================================================================
SELECT item.sk.s                    AS sort_key,
       item.data.m['email'].s       AS email,
       item.data.m['createdAt'].s   AS created_at
FROM addressium_prod.entities
WHERE export_date = '2026-07-27'
  AND item.pk IS NOT NULL
  AND item.pk.s = 'ORG#ORG'
  AND item.sk.s LIKE 'SUBSCRIBER#%'
LIMIT 100;
