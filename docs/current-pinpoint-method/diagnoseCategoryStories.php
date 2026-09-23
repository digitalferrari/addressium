<?php
/**
 * ============================================================================
 * CATEGORY STORIES DIAGNOSTIC V2 - WITH REAL LOOKBACK VERIFICATION
 * ============================================================================
 *
 * Same as V1, but now replicates the EXACT lookback calculation that
 * processNewslettersNew.php uses for each frequency type, so you can see
 * with your own eyes whether the main script's window is broken.
 *
 * For CUSTOM frequency newsletters, it also shows what the window WOULD BE
 * under the proposed <= 0 bug fix, proving the fix does what we expect.
 *
 * Usage:
 *   php diagnoseCategoryStoriesV2.php <configFile.ini>
 *   php diagnoseCategoryStoriesV2.php <configFile.ini> <scheduleID>
 *
 * READ-ONLY. No writes. No sends. No side effects.
 * ============================================================================
 */

ini_set('display_errors', 1);
error_reporting(E_ALL);
date_default_timezone_set('America/Denver');

// ----------------------------------------------------------------------------
// Config loading
// ----------------------------------------------------------------------------
function global_config($key) {
    $args = func_get_args();
    static $configsettings;
    if ($configsettings == null) $configsettings = [];
    if (count($args) >= 2) {
        $configsettings[$key] = $args[1];
        return null;
    }
    return array_key_exists($key, $configsettings) ? $configsettings[$key] : null;
}

function load_global_config($configLoc) {
    if (!is_file($configLoc)) throw new Exception("$configLoc not found\n");
    $config = parse_ini_file($configLoc);
    if ($config === false) throw new Exception("Could not parse $configLoc");
    foreach ($config as $key => $value) global_config($key, $value);
}

// ----------------------------------------------------------------------------
// Output helpers
// ----------------------------------------------------------------------------
function hr($char = '=') { echo str_repeat($char, 78) . "\n"; }
function h1($title) { echo "\n"; hr('='); echo "  $title\n"; hr('='); }
function h2($title) { echo "\n"; hr('-'); echo "  $title\n"; hr('-'); }
function ok($msg)   { echo "  OK   $msg\n"; }
function warn($msg) { echo "  WARN $msg\n"; }
function bad($msg)  { echo "  FAIL $msg\n"; }
function info($msg) { echo "       $msg\n"; }
function kv($k, $v) { printf("       %-34s : %s\n", $k, $v); }

function describeValue($v) {
    if ($v === null) return 'NULL';
    if ($v === '')   return 'EMPTY STRING';
    if (is_string($v)) return "'" . $v . "' (" . strlen($v) . " chars)";
    return var_export($v, true);
}

// ----------------------------------------------------------------------------
// EXACT replicas of the main script's lookback functions
// ----------------------------------------------------------------------------

/**
 * EXACT copy of processNewslettersNew.php's function - BUGGY VERSION
 * Uses `< 0` which allows today (days_diff = 0) to win the minimum.
 */
function most_recent_previous_day_of_week_BUGGY($current_day, $desired_days) {
    $days = array('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY');
    $current_day_index = array_search($current_day, $days);

    $days_to_subtract = PHP_INT_MAX;
    $most_recent_date = null;
    foreach ($desired_days as $desired_day) {
        $desired_day_index = array_search($desired_day, $days);
        $days_diff = $current_day_index - $desired_day_index;
        if ($days_diff < 0) {           // <-- THE BUG: allows 0 to win
            $days_diff += 7;
        }
        if ($days_diff < $days_to_subtract) {
            $days_to_subtract = $days_diff;
            $most_recent_date = date('Y-m-d', strtotime("-$days_to_subtract days"));
        }
    }
    return $most_recent_date;
}

/**
 * PROPOSED FIX - uses `<= 0` to force today to be treated as "7 days ago"
 */
function most_recent_previous_day_of_week_FIXED($current_day, $desired_days) {
    $days = array('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY');
    $current_day_index = array_search($current_day, $days);

    $days_to_subtract = PHP_INT_MAX;
    $most_recent_date = null;
    foreach ($desired_days as $desired_day) {
        $desired_day_index = array_search($desired_day, $days);
        $days_diff = $current_day_index - $desired_day_index;
        if ($days_diff <= 0) {          // <-- THE FIX: treat today as 7 days ago
            $days_diff += 7;
        }
        if ($days_diff < $days_to_subtract) {
            $days_to_subtract = $days_diff;
            $most_recent_date = date('Y-m-d', strtotime("-$days_to_subtract days"));
        }
    }
    return $most_recent_date;
}

/**
 * Compute $lastSendDate exactly as processNewslettersNew.php does.
 * Returns assoc array with both buggy and fixed versions when relevant.
 */
function computeLookback($frequency, $sendTime, $customFrequency) {
    $result = [
        'frequency' => $frequency,
        'buggy' => null,
        'fixed' => null,
        'explanation' => ''
    ];

    if ($frequency == 'DAILY') {
        $ts = mktime(
            date('H', strtotime($sendTime)),
            date('i', strtotime($sendTime)),
            date('s', strtotime($sendTime)),
            date('m'), date('d'), date('Y')
        );
        $lb = date('Y-m-d H:i:s', strtotime('-1 day', $ts));
        $result['buggy'] = $lb;
        $result['fixed'] = $lb;
        $result['explanation'] = 'DAILY: (today @ sendTime\'s H:i:s) - 1 day. Not affected by the bug.';

    } elseif ($frequency == 'WEEKLY') {
        $ts = mktime(
            date('H', strtotime($sendTime)),
            date('i', strtotime($sendTime)),
            date('s', strtotime($sendTime)),
            date('m'), date('d'), date('Y')
        );
        $lb = date('Y-m-d H:i:s', strtotime('-1 week', $ts));
        $result['buggy'] = $lb;
        $result['fixed'] = $lb;
        $result['explanation'] = 'WEEKLY: (today @ sendTime\'s H:i:s) - 1 week. Not affected by the bug.';

    } elseif ($frequency == 'MONTHLY') {
        $ts = mktime(
            date('H', strtotime($sendTime)),
            date('i', strtotime($sendTime)),
            date('s', strtotime($sendTime)),
            date('m'), date('d'), date('Y')
        );
        $lb = date('Y-m-d H:i:s', strtotime('-1 month', $ts));
        $result['buggy'] = $lb;
        $result['fixed'] = $lb;
        $result['explanation'] = 'MONTHLY: (today @ sendTime\'s H:i:s) - 1 month. Not affected by the bug.';

    } elseif ($frequency == 'CUSTOM') {
        $today = strtoupper(date('l'));
        $currentTime = date('H:i:s');

        $buggyDate = most_recent_previous_day_of_week_BUGGY($today, $customFrequency);
        $fixedDate = most_recent_previous_day_of_week_FIXED($today, $customFrequency);

        // Main script appends CURRENT H:i:s (not sendTime's), replicating that exactly
        $result['buggy'] = $buggyDate . ' ' . $currentTime;
        $result['fixed'] = $fixedDate . ' ' . $currentTime;

        $result['explanation'] = sprintf(
            "CUSTOM: today=%s, desired=[%s], currentTime=%s",
            $today,
            implode(',', $customFrequency),
            $currentTime
        );
        $result['buggyDateOnly'] = $buggyDate;
        $result['fixedDateOnly'] = $fixedDate;
    }

    return $result;
}

/**
 * Count posts that would be in the window for a given category value
 */
function countPostsInWindow($conn, $tp, $categoryValue, $lookbackDate, $limit) {
    if (empty($categoryValue)) return null;

    $isNumeric = is_numeric($categoryValue);
    if ($isNumeric) {
        $sql = "SELECT COUNT(*) as cnt FROM {$tp}posts p
                INNER JOIN {$tp}term_relationships tr ON p.ID = tr.object_id
                INNER JOIN {$tp}terms t ON tr.term_taxonomy_id = t.term_id
                WHERE t.term_id = " . (int)$categoryValue . "
                AND p.post_status = 'publish'
                AND p.post_type = 'post'
                AND p.post_date > '" . $conn->real_escape_string($lookbackDate) . "'";
    } else {
        $safe = $conn->real_escape_string($categoryValue);
        $sql = "SELECT COUNT(*) as cnt FROM {$tp}posts p
                INNER JOIN {$tp}term_relationships tr ON p.ID = tr.object_id
                INNER JOIN {$tp}terms t ON tr.term_taxonomy_id = t.term_id
                WHERE t.slug = '$safe'
                AND p.post_status = 'publish'
                AND p.post_type = 'post'
                AND p.post_date > '" . $conn->real_escape_string($lookbackDate) . "'";
    }

    $res = $conn->query($sql);
    if (!$res) return null;
    $row = $res->fetch_assoc();
    $count = (int)$row['cnt'];
    return min($count, $limit);
}

/**
 * List posts in window (actual titles, not just count)
 */
function listPostsInWindow($conn, $tp, $categoryValue, $lookbackDate, $limit) {
    if (empty($categoryValue)) return [];

    $isNumeric = is_numeric($categoryValue);
    if ($isNumeric) {
        $sql = "SELECT p.ID, p.post_title, p.post_date FROM {$tp}posts p
                INNER JOIN {$tp}term_relationships tr ON p.ID = tr.object_id
                INNER JOIN {$tp}terms t ON tr.term_taxonomy_id = t.term_id
                WHERE t.term_id = " . (int)$categoryValue . "
                AND p.post_status = 'publish'
                AND p.post_type = 'post'
                AND p.post_date > '" . $conn->real_escape_string($lookbackDate) . "'
                ORDER BY p.post_date DESC LIMIT $limit";
    } else {
        $safe = $conn->real_escape_string($categoryValue);
        $sql = "SELECT p.ID, p.post_title, p.post_date FROM {$tp}posts p
                INNER JOIN {$tp}term_relationships tr ON p.ID = tr.object_id
                INNER JOIN {$tp}terms t ON tr.term_taxonomy_id = t.term_id
                WHERE t.slug = '$safe'
                AND p.post_status = 'publish'
                AND p.post_type = 'post'
                AND p.post_date > '" . $conn->real_escape_string($lookbackDate) . "'
                ORDER BY p.post_date DESC LIMIT $limit";
    }

    $res = $conn->query($sql);
    $out = [];
    if ($res) while ($r = $res->fetch_assoc()) $out[] = $r;
    return $out;
}

// ----------------------------------------------------------------------------
// Argument parsing
// ----------------------------------------------------------------------------
if (!isset($argv[1])) {
    die("Usage: php diagnoseCategoryStoriesV2.php <configFile.ini> [scheduleID]\n");
}

$confFile = $argv[1];
$targetScheduleID = isset($argv[2]) ? (int)$argv[2] : null;

load_global_config($confFile);

$conn = new mysqli(
    global_config('wpServer'),
    global_config('wpUsername'),
    global_config('wpPassword'),
    global_config('wpDB'),
    "3306"
);
if ($conn->connect_error) die("Connection failed: " . $conn->connect_error . "\n");
$conn->query("SET NAMES 'utf8mb4' COLLATE 'utf8mb4_general_ci';");

$tp = global_config('wpTablePrefix');

h1("CATEGORY STORIES DIAGNOSTIC V2 (with real lookback verification)");
kv('Config', basename($confFile));
kv('Database', global_config('wpDB'));
kv('Table Prefix', $tp);
kv('Run Time', date('Y-m-d H:i:s l'));

// ----------------------------------------------------------------------------
// If no schedule ID, list Manual newsletters
// ----------------------------------------------------------------------------
if ($targetScheduleID === null) {
    h2("No schedule ID specified - listing Manual newsletters");
    $listSQL = "SELECT id, newsletterDisplayName, newsletterID, frequency, sendTime, customFrequency
                FROM {$tp}aws_pinpoint_newsletter_schedules
                WHERE newsletterType = 'Manual'
                ORDER BY newsletterDisplayName";
    $res = $conn->query($listSQL);
    if (!$res || $res->num_rows == 0) {
        bad("No Manual newsletters found");
        exit(1);
    }

    echo "\n";
    printf("  %-4s | %-40s | %-8s | %-8s | %s\n", 'ID', 'Name', 'Freq', 'SendH:i', 'CustomDays');
    echo "  " . str_repeat('-', 76) . "\n";
    while ($r = $res->fetch_assoc()) {
        $cf = '';
        if ($r['customFrequency']) {
            $parsed = @unserialize($r['customFrequency']);
            if (is_array($parsed)) $cf = implode(',', array_map(function($d){return substr($d,0,3);}, $parsed));
        }
        printf("  %-4s | %-40s | %-8s | %-8s | %s\n",
            $r['id'],
            substr($r['newsletterDisplayName'], 0, 40),
            $r['frequency'],
            date('H:i', strtotime($r['sendTime'])),
            $cf
        );
    }
    echo "\n";
    info("Re-run with: php diagnoseCategoryStoriesV2.php $confFile <ID>");
    exit(0);
}

// ----------------------------------------------------------------------------
// Fetch schedule
// ----------------------------------------------------------------------------
h1("STEP 1: SCHEDULE");
$schedSQL = "SELECT * FROM {$tp}aws_pinpoint_newsletter_schedules WHERE id = $targetScheduleID";
$schedRes = $conn->query($schedSQL);
if (!$schedRes || $schedRes->num_rows == 0) {
    bad("No schedule found with ID $targetScheduleID");
    exit(1);
}
$schedule = $schedRes->fetch_assoc();
ok("Schedule loaded");
kv('Display Name', $schedule['newsletterDisplayName']);
kv('newsletterType', $schedule['newsletterType']);
kv('Frequency', $schedule['frequency']);
kv('sendTime', $schedule['sendTime']);
kv('sendTime H:i:s', date('H:i:s', strtotime($schedule['sendTime'])));

$customFrequency = [];
if ($schedule['frequency'] == 'CUSTOM' && $schedule['customFrequency']) {
    $customFrequency = @unserialize($schedule['customFrequency']);
    if (!is_array($customFrequency)) $customFrequency = [];
    kv('customFrequency', '[' . implode(', ', $customFrequency) . ']');
}

$manualNewsletterID = (int)$schedule['newsletterID'];

// ----------------------------------------------------------------------------
// Fetch category config
// ----------------------------------------------------------------------------
h1("STEP 2: CATEGORY CONFIGURATION");
$catSQL = "SELECT
    meta1.meta_value as aftermainone_cat,
    meta2.meta_value as aftermaintwo_cat
    FROM {$tp}posts p
    LEFT JOIN {$tp}postmeta meta1 ON p.ID = meta1.post_id AND meta1.meta_key = 'newsletter_aftermainone_stories'
    LEFT JOIN {$tp}postmeta meta2 ON p.ID = meta2.post_id AND meta2.meta_key = 'newsletter_aftermaintwo_stories'
    WHERE p.ID = $manualNewsletterID";
$catRes = $conn->query($catSQL);
if (!$catRes || $catRes->num_rows == 0) {
    bad("No category fields for post $manualNewsletterID");
    exit(1);
}
$catData = $catRes->fetch_assoc();
$catOne = $catData['aftermainone_cat'];
$catTwo = $catData['aftermaintwo_cat'];
kv('aftermainone_stories', describeValue($catOne));
kv('aftermaintwo_stories', describeValue($catTwo));

// ----------------------------------------------------------------------------
// THE MAIN EVENT: compute lookback exactly as processNewslettersNew.php does
// ----------------------------------------------------------------------------
h1("STEP 3: REAL LOOKBACK CALCULATION (matches processNewslettersNew.php)");

$lookback = computeLookback($schedule['frequency'], $schedule['sendTime'], $customFrequency);
kv('Explanation', $lookback['explanation']);

echo "\n";
info("Lookback produced by CURRENT (potentially buggy) code:");
kv('  $lastSendDate (BUGGY)', $lookback['buggy']);

if ($schedule['frequency'] == 'CUSTOM') {
    info("Lookback produced by PROPOSED FIX (<= 0):");
    kv('  $lastSendDate (FIXED)', $lookback['fixed']);

    if ($lookback['buggy'] === $lookback['fixed']) {
        warn("Buggy and fixed values are IDENTICAL - no difference today");
        info("This can happen if today is NOT the first desired_day in the list");
        info("encountered with days_diff == 0. Safe to deploy, but today's run");
        info("will not change behavior.");
    } else {
        ok("Buggy and fixed values DIFFER - the fix will change today's behavior");

        $buggyDateOnly = $lookback['buggyDateOnly'];
        $fixedDateOnly = $lookback['fixedDateOnly'];
        $todayStr = date('Y-m-d');

        if ($buggyDateOnly === $todayStr) {
            bad("BUGGY lookback starts TODAY - window is essentially empty");
            info("This is the bug in action. No Opinion post published before");
            info("$buggyDateOnly " . date('H:i:s') . " will be included in today's newsletter.");
        }
    }
}

// ----------------------------------------------------------------------------
// Count posts under each window
// ----------------------------------------------------------------------------
h1("STEP 4: POSTS IN WINDOW - BUGGY vs FIXED");

foreach ([['CATEGORY ONE (aftermainone)', $catOne, 3], ['CATEGORY TWO (aftermaintwo)', $catTwo, 2]] as $pair) {
    list($label, $value, $limit) = $pair;
    h2($label);
    if (empty($value)) {
        info("(field is empty - skipping)");
        continue;
    }
    kv('Category value', $value);

    // Buggy window
    $buggyPosts = listPostsInWindow($conn, $tp, $value, $lookback['buggy'], $limit);
    echo "\n";
    info("Under BUGGY window (since {$lookback['buggy']}):");
    if (empty($buggyPosts)) {
        bad("  0 posts - EMPTY RESULT (this is what today's email got)");
    } else {
        ok("  " . count($buggyPosts) . " post(s):");
        foreach ($buggyPosts as $p) {
            info("    [{$p['ID']}] {$p['post_date']}  {$p['post_title']}");
        }
    }

    // Fixed window
    if ($schedule['frequency'] == 'CUSTOM') {
        $fixedPosts = listPostsInWindow($conn, $tp, $value, $lookback['fixed'], $limit);
        echo "\n";
        info("Under FIXED window (since {$lookback['fixed']}):");
        if (empty($fixedPosts)) {
            warn("  0 posts - fix doesn't help today (nothing in window either way)");
        } else {
            ok("  " . count($fixedPosts) . " post(s):");
            foreach ($fixedPosts as $p) {
                info("    [{$p['ID']}] {$p['post_date']}  {$p['post_title']}");
            }
        }
    }
}

// ----------------------------------------------------------------------------
// Simulate the fix over the next 7 days to confirm no regressions
// ----------------------------------------------------------------------------
if ($schedule['frequency'] == 'CUSTOM') {
    h1("STEP 5: 7-DAY FORWARD SIMULATION (buggy vs fixed)");
    info("Simulating what the lookback WOULD BE on each of the next 7 days");
    info("using both buggy and fixed functions. This confirms the fix doesn't");
    info("break days that currently work.");
    echo "\n";

    printf("  %-12s | %-10s | %-12s | %-12s | %s\n",
        'Date', 'DayOfWeek', 'BUGGY date', 'FIXED date', 'Scheduled?');
    echo "  " . str_repeat('-', 76) . "\n";

    for ($i = 0; $i < 7; $i++) {
        $simTs = strtotime("+$i days");
        $simDate = date('Y-m-d', $simTs);
        $simDay = strtoupper(date('l', $simTs));
        $isScheduled = in_array($simDay, $customFrequency);

        // Temporarily shift "today" by using a custom sim
        // Since the function uses date() internally, we need to simulate.
        // Simplest: compute manually using the same logic.
        $days = array('SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY');
        $simIdx = array_search($simDay, $days);

        // Buggy
        $buggyMin = PHP_INT_MAX;
        foreach ($customFrequency as $dd) {
            $ddIdx = array_search($dd, $days);
            $diff = $simIdx - $ddIdx;
            if ($diff < 0) $diff += 7;
            if ($diff < $buggyMin) $buggyMin = $diff;
        }
        $buggySimDate = date('Y-m-d', strtotime("-$buggyMin days", $simTs));

        // Fixed
        $fixedMin = PHP_INT_MAX;
        foreach ($customFrequency as $dd) {
            $ddIdx = array_search($dd, $days);
            $diff = $simIdx - $ddIdx;
            if ($diff <= 0) $diff += 7;
            if ($diff < $fixedMin) $fixedMin = $diff;
        }
        $fixedSimDate = date('Y-m-d', strtotime("-$fixedMin days", $simTs));

        printf("  %-12s | %-10s | %-12s | %-12s | %s\n",
            $simDate,
            substr($simDay, 0, 3),
            $buggySimDate,
            $fixedSimDate,
            $isScheduled ? 'YES' : 'no'
        );
    }

    echo "\n";
    info("If on scheduled days the BUGGY column shows today's date and FIXED shows");
    info("the prior scheduled day, the bug and fix are both confirmed.");
}

// ----------------------------------------------------------------------------
// Verdict
// ----------------------------------------------------------------------------
h1("VERDICT");

if ($schedule['frequency'] != 'CUSTOM') {
    ok("This is a $schedule[frequency] newsletter - unaffected by the CUSTOM lookback bug.");
    info("Use this as a CONTROL to verify the diagnostic's lookback matches real behavior.");
} else {
    // Compute buggy vs fixed post count for cat one
    if (!empty($catOne)) {
        $bCount = count(listPostsInWindow($conn, $tp, $catOne, $lookback['buggy'], 999));
        $fCount = count(listPostsInWindow($conn, $tp, $catOne, $lookback['fixed'], 999));

        if ($bCount == 0 && $fCount > 0) {
            bad("CONFIRMED: Buggy lookback finds 0 posts, fixed lookback finds $fCount");
            info("Deploying the `<= 0` fix WILL restore Opinion content to this newsletter.");
        } elseif ($bCount > 0 && $fCount > 0) {
            warn("Both windows find posts - bug may not be manifesting today");
            info("Buggy: $bCount posts, Fixed: $fCount posts");
            info("Deploy the fix anyway - it's correct semantically.");
        } elseif ($bCount == 0 && $fCount == 0) {
            warn("Neither window finds posts - there may be no content to show today");
            info("Run again later after more posts are published, or check a different schedule.");
        }
    }
}

echo "\n";
hr('=');
info("To apply the fix: change `< 0` to `<= 0` in most_recent_previous_day_of_week()");
info("inside processNewslettersNew.php.");
hr('=');
echo "\n";

$conn->close();