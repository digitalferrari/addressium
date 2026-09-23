<?php
/**
 * ============================================================================
 * NEWSLETTER SCHEDULING UNIT TEST
 * ============================================================================
 *
 * This script simulates the newsletter scheduling logic over a full week,
 * minute by minute, to verify correct send times without actually sending
 * emails or modifying any data.
 *
 * Usage: php processNewslettersUnitTest.php <configFile.ini>
 *
 * Example: php processNewslettersUnitTest.php swift-pinpoint-cron/Configs/tdConfig.ini
 *
 * Output: Creates a test report file in the current directory
 *
 * IMPORTANT: This is READ-ONLY. No emails will be sent. No database updates.
 * ============================================================================
 */

ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);
ini_set('memory_limit', '2048M');
date_default_timezone_set('America/Denver');

// ============================================================================
// SIMULATED TIME SYSTEM
// ============================================================================
$SIMULATED_TIME = null;  // Global simulated timestamp

/**
 * Get simulated date/time instead of real time
 * This replaces all date() calls in the test
 */
function simDate($format, $timestamp = null) {
    global $SIMULATED_TIME;
    if ($timestamp === null) {
        $timestamp = $SIMULATED_TIME;
    }
    return date($format, $timestamp);
}

/**
 * Get simulated strtotime
 */
function simStrtotime($timeString, $baseTime = null) {
    global $SIMULATED_TIME;
    if ($baseTime === null) {
        $baseTime = $SIMULATED_TIME;
    }

    // Handle relative time strings
    if (strpos($timeString, '+') === 0 || strpos($timeString, '-') === 0) {
        return strtotime($timeString, $baseTime);
    }

    // For absolute times, just use normal strtotime
    return strtotime($timeString);
}

// ============================================================================
// TEST TRACKING
// ============================================================================
$TEST_RESULTS = [];
$PINPOINT_UPDATES = [];      // Every time script would call Pinpoint API
$ACTUAL_SENDS = [];          // Actual emails that would be sent (1 per newsletter per scheduled time)
$SKIP_EVENTS = [];
$OUTPUT_LINES = [];
$PROCESSED_SENDS = [];       // Track which newsletter+date combos we've already recorded
$CUSTOM_UPDATES = [];        // Track CUSTOM frequency updates (pushing StartTime forward)

function addTestOutput($message) {
    global $OUTPUT_LINES;
    $OUTPUT_LINES[] = $message;
}

function recordPinpointUpdate($simTime, $newsletterId, $newsletter, $details = []) {
    global $PINPOINT_UPDATES;
    $PINPOINT_UPDATES[] = [
        'timestamp' => date('Y-m-d H:i:s', $simTime),
        'day' => date('l', $simTime),
        'newsletterId' => $newsletterId,
        'newsletter' => $newsletter,
        'details' => $details
    ];
}

function recordActualSend($simTime, $newsletterId, $newsletter, $scheduledSendTime, $details = []) {
    global $ACTUAL_SENDS, $PROCESSED_SENDS;

    // Create unique key: newsletter ID + scheduled send date
    // This ensures we only count ONE send per newsletter per scheduled time
    $sendKey = $newsletterId . '_' . $scheduledSendTime;

    if (!isset($PROCESSED_SENDS[$sendKey])) {
        $PROCESSED_SENDS[$sendKey] = true;
        $ACTUAL_SENDS[] = [
            'timestamp' => date('Y-m-d H:i:s', $simTime),
            'scheduledSendTime' => $scheduledSendTime,
            'day' => date('l', strtotime($scheduledSendTime)),
            'newsletterId' => $newsletterId,
            'newsletter' => $newsletter,
            'details' => $details
        ];
        return true;  // First time seeing this send
    }
    return false;  // Already recorded this send
}

function recordSkipEvent($simTime, $newsletter, $reason, $details = []) {
    global $SKIP_EVENTS;
    $SKIP_EVENTS[] = [
        'timestamp' => date('Y-m-d H:i:s', $simTime),
        'newsletter' => $newsletter,
        'reason' => $reason,
        'details' => $details
    ];
}

function recordCustomUpdate($simTime, $newsletterId, $newsletter, $nextSendTime, $details = []) {
    global $CUSTOM_UPDATES, $PROCESSED_SENDS;

    // Create unique key to avoid duplicate records for same update
    $updateKey = $newsletterId . '_custom_' . date('Y-m-d', $simTime);

    if (!isset($PROCESSED_SENDS[$updateKey])) {
        $PROCESSED_SENDS[$updateKey] = true;
        $CUSTOM_UPDATES[] = [
            'timestamp' => date('Y-m-d H:i:s', $simTime),
            'day' => date('l', $simTime),
            'newsletterId' => $newsletterId,
            'newsletter' => $newsletter,
            'nextSendTime' => $nextSendTime,
            'details' => $details
        ];
        return true;
    }
    return false;
}

// ============================================================================
// CONFIGURATION
// ============================================================================
if (!isset($argv[1])) {
    die("Usage: php processNewslettersUnitTest.php <configFile.ini>\n");
}

$confFile = $argv[1];
$confFileName = basename($confFile);
$confFileParts = explode(".", $confFileName);
$marketCode = substr($confFileParts[0], 0, 2);

// Config loading (same as original)
function global_config($key) {
    $args = func_get_args();
    static $configsettings;
    if ($configsettings == null) {
        $configsettings = array();
    }
    if (count($args) >= 2) {
        $configsettings[$key] = $args[1];
        return null;
    } else {
        return array_key_exists($key, $configsettings) ? $configsettings[$key] : null;
    }
}

function load_global_config($configLoc) {
    $configlocation = $configLoc;
    if (!is_file($configlocation)) {
        throw new Exception("$configlocation not found, please create an ini file with this name.\n");
    }
    $config = parse_ini_file($configlocation);
    if ($config === false) {
        throw new Exception("Could not parse $configlocation as an ini file.");
    }
    foreach ($config as $key => $value) {
        global_config($key, $value);
    }
}

load_global_config($confFile);

// Database connection (READ ONLY - no writes!)
$server = global_config('wpServer');
$username = global_config('wpUsername');
$password = global_config('wpPassword');
$dbname = global_config('wpDB');
$port = "3306";

$conn = new mysqli($server, $username, $password, $dbname, $port);
if ($conn->connect_error) {
    die("Connection failed: " . $conn->connect_error);
}
$conn->query("SET NAMES 'utf8mb4' COLLATE 'utf8mb4_general_ci';");

// ============================================================================
// HELPER FUNCTIONS (copied from original, using simDate)
// ============================================================================

function most_recent_previous_day_of_week($current_day, $desired_days) {
    $days = array('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY');
    $current_day_index = array_search($current_day, $days);

    $days_to_subtract = PHP_INT_MAX;
    $most_recent_date = null;
    foreach ($desired_days as $desired_day) {
        $desired_day_index = array_search($desired_day, $days);
        $days_diff = $current_day_index - $desired_day_index;
        if ($days_diff < 0) {
            $days_diff += 7;
        }
        if ($days_diff < $days_to_subtract) {
            $days_to_subtract = $days_diff;
            global $SIMULATED_TIME;
            $most_recent_date = date('Y-m-d', strtotime("-$days_to_subtract days", $SIMULATED_TIME));
        }
    }

    return $most_recent_date;
}

function next_day_of_week($current_day, $desired_days, $effectiveDate) {
    $days = array('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY');
    $current_day_index = array_search($current_day, $days);

    $days_to_add = PHP_INT_MAX;
    foreach ($desired_days as $desired_day) {
        $desired_day_index = array_search($desired_day, $days);
        $days_diff = $desired_day_index - $current_day_index;
        if ($days_diff < 0) {
            $days_diff += 7;
        }
        if ($days_diff < $days_to_add) {
            $days_to_add = $days_diff;
        }
    }

    $next_date = date('Y-m-d', strtotime($effectiveDate . "+$days_to_add days"));
    return $next_date;
}

// ============================================================================
// MAIN TEST SIMULATION
// ============================================================================

/**
 * Pre-process newsletter data ONCE before simulation
 * Caches all necessary data to avoid repeated DB queries
 */
function preprocessNewsletters($newsletters, $conn) {
    $processed = [];

    foreach ($newsletters as $schedule) {
        $data = $schedule;

        // Parse custom frequency once
        $data['customFrequencyParsed'] = ($schedule['customFrequency'] != null)
            ? unserialize($schedule['customFrequency'])
            : [];

        // Pre-calculate static values
        $data['scheduledTimeOfDay'] = date('H:i:s', strtotime($schedule['sendTime']));
        $data['scheduleWeekday'] = strtoupper(date('l', strtotime($schedule['sendTime'])));
        $data['scheduleDayOfMonth'] = date('d', strtotime($schedule['sendTime']));

        // Pre-calculate send window (these are time-of-day based, not date based)
        $data['windowStart'] = date('H:i:s', strtotime($schedule['sendTime']) - 600);
        $data['windowEnd'] = date('H:i:s', strtotime($schedule['sendTime']) - 300);

        // Check content availability ONCE for Manual newsletters
        $data['hasContent'] = true;  // Default to true
        if ($schedule['newsletterType'] == 'Manual' && !empty($schedule['newsletterID'])) {
            $manualNewsletterID = $schedule['newsletterID'];
            $checkSQL = "SELECT COUNT(*) as cnt FROM " . global_config('wpTablePrefix') . "postmeta
                         WHERE post_id = $manualNewsletterID
                         AND meta_key LIKE 'newsletter_stories_%'
                         AND meta_value != ''";
            $checkResult = $conn->query($checkSQL);
            if ($checkResult) {
                $row = $checkResult->fetch_assoc();
                $data['hasContent'] = ($row['cnt'] > 0);
            }
        }

        $processed[] = $data;
    }

    return $processed;
}

/**
 * Evaluate whether a newsletter would send at the given simulated time
 * Uses pre-cached data - NO database queries
 */
function evaluateNewsletterAtTime($schedule, $simTime) {
    global $SIMULATED_TIME;
    $SIMULATED_TIME = $simTime;

    $result = [
        'would_send' => false,
        'would_skip' => false,
        'reason' => '',
        'details' => []
    ];

    // Use pre-cached data (no DB queries!)
    $newsletterDisplayName = $schedule['newsletterDisplayName'];
    $newsletterType = $schedule['newsletterType'];
    $frequency = $schedule['frequency'];
    $endOn = $schedule['endOn'];
    $endDate = $schedule['endDate'];
    $customFrequency = $schedule['customFrequencyParsed'];
    $segmentName = $schedule['segmentName'];
    $hasContent = $schedule['hasContent'];

    // Pre-calculated values
    $scheduleWeekday = $schedule['scheduleWeekday'];
    $scheduleDayOfMonth = $schedule['scheduleDayOfMonth'];
    $windowStart = $schedule['windowStart'];
    $windowEnd = $schedule['windowEnd'];
    $scheduledTimeOfDay = $schedule['scheduledTimeOfDay'];

    // Simulated time values
    $nowDate = simDate('Y-m-d');
    $currentWeekday = strtoupper(simDate('l'));
    $currentTime = simDate('H:i:s');
    $currentDayOfMonth = simDate('d');

    // Check if in time window
    $inTimeWindow = ($currentTime >= $windowStart && $currentTime <= $windowEnd);

    // Check frequency conditions
    $frequencyMatch = false;
    $frequencyReason = '';

    if ($frequency == 'DAILY') {
        $frequencyMatch = true;
        $frequencyReason = 'DAILY frequency always matches';
    } elseif ($frequency == 'WEEKLY' && $scheduleWeekday == $currentWeekday) {
        $frequencyMatch = true;
        $frequencyReason = "WEEKLY: scheduled=$scheduleWeekday, current=$currentWeekday";
    } elseif ($frequency == 'WEEKLY') {
        $frequencyReason = "WEEKLY mismatch: scheduled=$scheduleWeekday, current=$currentWeekday";
    } elseif ($frequency == 'MONTHLY' && $scheduleDayOfMonth == $currentDayOfMonth) {
        $frequencyMatch = true;
        $frequencyReason = 'MONTHLY: day of month matches';
    } elseif ($frequency == 'MONTHLY') {
        $frequencyReason = "MONTHLY mismatch: scheduled day=$scheduleDayOfMonth, current=$currentDayOfMonth";
    } elseif ($frequency == 'CUSTOM' && in_array($currentWeekday, $customFrequency)) {
        $frequencyMatch = true;
        $frequencyReason = "CUSTOM: $currentWeekday is in [" . implode(',', $customFrequency) . "]";
    } elseif ($frequency == 'CUSTOM') {
        $frequencyReason = "CUSTOM mismatch: $currentWeekday not in [" . implode(',', $customFrequency) . "]";
    }

    // Check end date
    $endDateOk = ($endOn == 'Never' || $endOn == 'never' || (isset($endDate) && $endDate >= $nowDate));

    // Final decision
    $shouldProcess = $frequencyMatch && $endDateOk && $inTimeWindow;

    $result['details'] = [
        'newsletter' => $newsletterDisplayName,
        'type' => $newsletterType,
        'frequency' => $frequency,
        'customFrequency' => $customFrequency,
        'scheduledTimeOfDay' => $scheduledTimeOfDay,
        'currentSimTime' => simDate('Y-m-d H:i:s'),
        'currentWeekday' => $currentWeekday,
        'windowStart' => $windowStart,
        'windowEnd' => $windowEnd,
        'inTimeWindow' => $inTimeWindow,
        'frequencyMatch' => $frequencyMatch,
        'frequencyReason' => $frequencyReason,
        'endDateOk' => $endDateOk,
        'shouldProcess' => $shouldProcess,
        'segmentName' => $segmentName,
        'hasContent' => $hasContent
    ];

    if ($shouldProcess) {
        if ($hasContent) {
            $result['would_send'] = true;
            $result['reason'] = 'IN SEND WINDOW - Would send email';
            $result['calculated_send_time'] = simDate('Y-m-d') . ' ' . $scheduledTimeOfDay;
        } else {
            $result['would_skip'] = true;
            $result['reason'] = 'IN SEND WINDOW but NO CONTENT - Would skip/pause';
        }
    } else {
        $reasons = [];
        if (!$frequencyMatch) $reasons[] = "frequency mismatch ($frequencyReason)";
        if (!$endDateOk) $reasons[] = "past end date";
        if (!$inTimeWindow) $reasons[] = "outside time window ($currentTime not in $windowStart-$windowEnd)";

        $result['reason'] = 'Not processing: ' . implode(', ', $reasons);

        // Special handling for CUSTOM frequency - would update campaign to next valid day
        // This prevents Pinpoint from sending on days not in the customFrequency array
        if ($frequency == 'CUSTOM' && !empty($customFrequency)) {
            $desired_days = $customFrequency;
            $effectiveDate = simDate('Y-m-d');
            $current_day = strtoupper(simDate('l'));
            $next_date = next_day_of_week($current_day, $desired_days, $effectiveDate);

            // Calculate what the next sendTime would be set to
            $nextSendTime = $next_date . ' ' . $scheduledTimeOfDay;

            // Check if today is a valid day but send time has passed
            if (in_array($currentWeekday, $customFrequency) && $currentTime > $scheduledTimeOfDay) {
                // Calculate from tomorrow
                $tomorrow = simDate('Y-m-d', simStrtotime('+1 day'));
                $tomorrowDay = strtoupper(date('l', strtotime($tomorrow)));
                $next_date = next_day_of_week($tomorrowDay, $desired_days, $tomorrow);
                $nextSendTime = $next_date . ' ' . $scheduledTimeOfDay;
            }

            // Check if we're in the time window for CUSTOM handling
            if ($inTimeWindow) {
                $result['would_update_custom'] = true;
                $result['custom_next_send_time'] = $nextSendTime;
                $result['reason'] .= " | CUSTOM: Would update StartTime to $nextSendTime";
            }

            $result['details']['custom_next_date'] = $next_date;
            $result['details']['custom_next_send_time'] = $nextSendTime;
        }
    }

    return $result;
}

// ============================================================================
// RUN THE SIMULATION
// ============================================================================

echo "============================================================================\n";
echo "NEWSLETTER SCHEDULING UNIT TEST\n";
echo "============================================================================\n";
echo "Market Code: $marketCode\n";
echo "Config File: $confFile\n";
echo "Database: $dbname\n";
echo "Real Current Time: " . date('Y-m-d H:i:s') . "\n";
echo "============================================================================\n\n";

// Get all active newsletter schedules
$nowDate = date('Y-m-d');
$scheduleSQL = "SELECT * FROM " . global_config('wpTablePrefix') . "aws_pinpoint_newsletter_schedules
                WHERE (endOn = 'Never' OR endDate >= '$nowDate')
                ORDER BY newsletterDisplayName";
$scheduleResult = $conn->query($scheduleSQL);
$newsletters = [];

if ($scheduleResult) {
    while ($row = $scheduleResult->fetch_assoc()) {
        $newsletters[] = $row;
    }
}

$newsletterCount = count($newsletters);
echo "Found $newsletterCount active newsletter schedules:\n";
echo "----------------------------------------------------------------------------\n";
foreach ($newsletters as $nl) {
    $customFreqDisplay = '';
    if ($nl['frequency'] == 'CUSTOM' && !empty($nl['customFrequency'])) {
        $customFreqDisplay = ' [' . implode(',', unserialize($nl['customFrequency'])) . ']';
    }
    echo sprintf("  - %-40s | %-8s | %s%s\n",
        substr($nl['newsletterDisplayName'], 0, 40),
        $nl['frequency'],
        date('H:i', strtotime($nl['sendTime'])),
        $customFreqDisplay
    );
}
echo "============================================================================\n\n";

// PRE-PROCESS ALL DATA ONCE (this is where ALL database queries happen)
echo "Pre-processing newsletter data (one-time database queries)...\n";
$newsletters = preprocessNewsletters($newsletters, $conn);
echo "Done. All data cached in memory.\n\n";

// Close database connection - we don't need it anymore!
$conn->close();
echo "Database connection closed. Running pure in-memory simulation.\n";
echo "============================================================================\n\n";

// Calculate simulation period: Start at midnight today, run for 7 days
$simStart = strtotime(date('Y-m-d') . ' 00:00:00');
$simEnd = strtotime('+7 days', $simStart);
$totalMinutes = ($simEnd - $simStart) / 60;

echo "Simulation Period:\n";
echo "  Start: " . date('Y-m-d H:i:s (l)', $simStart) . "\n";
echo "  End:   " . date('Y-m-d H:i:s (l)', $simEnd) . "\n";
echo "  Total Minutes: " . number_format($totalMinutes) . "\n";
echo "============================================================================\n\n";

// Output file
$outputFile = "newsletter_test_report_" . $marketCode . "_" . date('Y-m-d_His') . ".txt";
$fp = fopen($outputFile, 'w');

fwrite($fp, "============================================================================\n");
fwrite($fp, "NEWSLETTER SCHEDULING UNIT TEST REPORT\n");
fwrite($fp, "============================================================================\n");
fwrite($fp, "Market Code: $marketCode\n");
fwrite($fp, "Config File: $confFile\n");
fwrite($fp, "Generated: " . date('Y-m-d H:i:s') . "\n");
fwrite($fp, "Simulation: " . date('Y-m-d H:i', $simStart) . " to " . date('Y-m-d H:i', $simEnd) . "\n");
fwrite($fp, "============================================================================\n\n");

// Progress tracking
$progressInterval = 1440;  // Show progress every day (1440 minutes)
$minutesProcessed = 0;

echo "Running simulation...\n";

// Run the simulation
for ($simTime = $simStart; $simTime < $simEnd; $simTime += 60) {
    $SIMULATED_TIME = $simTime;
    $simTimeStr = date('Y-m-d H:i:s', $simTime);
    $simDay = date('l', $simTime);

    $minuteHadEvent = false;
    $minuteOutput = "[$simTimeStr] ($simDay)\n";

    foreach ($newsletters as $schedule) {
        $result = evaluateNewsletterAtTime($schedule, $simTime);
        $newsletterId = $schedule['id'];

        if ($result['would_send']) {
            $minuteHadEvent = true;
            $scheduledSendTime = $result['calculated_send_time'];

            // Record Pinpoint API update (happens every minute in window)
            recordPinpointUpdate($simTime, $newsletterId, $result['details']['newsletter'], $result['details']);

            // Record actual send (only once per newsletter per scheduled time)
            $isNewSend = recordActualSend($simTime, $newsletterId, $result['details']['newsletter'], $scheduledSendTime, $result['details']);

            if ($isNewSend) {
                // First time we've seen this send - log it prominently
                $eventLine = "  >>> ACTUAL EMAIL SEND: " . $result['details']['newsletter'] . "\n";
                $eventLine .= "      Scheduled Send Time: " . $scheduledSendTime . "\n";
                $eventLine .= "      Type: " . $result['details']['type'] . " | Frequency: " . $result['details']['frequency'] . "\n";
                $eventLine .= "      Segment: " . $result['details']['segmentName'] . "\n";
            } else {
                // Subsequent API update for same send - log quietly
                $eventLine = "      (Pinpoint API update for: " . $result['details']['newsletter'] . ")\n";
            }
            $minuteOutput .= $eventLine;

        } elseif ($result['would_skip']) {
            $minuteHadEvent = true;
            $eventLine = "  >>> WOULD SKIP (no content): " . $result['details']['newsletter'] . "\n";
            $minuteOutput .= $eventLine;

            recordSkipEvent($simTime, $result['details']['newsletter'], $result['reason'], $result['details']);
        } elseif (isset($result['would_update_custom']) && $result['would_update_custom']) {
            $minuteHadEvent = true;
            $nextSendTime = $result['custom_next_send_time'];
            $isNewUpdate = recordCustomUpdate($simTime, $newsletterId, $result['details']['newsletter'], $nextSendTime, $result['details']);

            if ($isNewUpdate) {
                $eventLine = "  >>> CUSTOM UPDATE: " . $result['details']['newsletter'] . "\n";
                $eventLine .= "      Would push StartTime to: " . $nextSendTime . " (" . date('l', strtotime($nextSendTime)) . ")\n";
                $eventLine .= "      (Prevents Pinpoint from sending on " . date('l', $simTime) . ")\n";
            } else {
                $eventLine = "      (CUSTOM update already recorded for: " . $result['details']['newsletter'] . ")\n";
            }
            $minuteOutput .= $eventLine;
        }
    }

    // Write to file only when there are events (reduces file size dramatically)
    if ($minuteHadEvent) {
        fwrite($fp, $minuteOutput);
    }

    // Progress indicator
    $minutesProcessed++;
    if ($minutesProcessed % $progressInterval == 0) {
        $pctComplete = round(($minutesProcessed / $totalMinutes) * 100, 1);
        echo "  Progress: $pctComplete% - Simulated up to " . date('Y-m-d H:i', $simTime) . "\n";
    }
}

echo "\nSimulation complete!\n\n";

// ============================================================================
// GENERATE SUMMARY
// ============================================================================

fwrite($fp, "\n\n");
fwrite($fp, "============================================================================\n");
fwrite($fp, "                              SUMMARY\n");
fwrite($fp, "============================================================================\n\n");

fwrite($fp, "IMPORTANT DISTINCTION:\n");
fwrite($fp, "  - 'Actual Email Sends': Unique emails sent (1 per newsletter per scheduled time)\n");
fwrite($fp, "  - 'Pinpoint API Updates': API calls made (up to 6 per send, one per minute in window)\n");
fwrite($fp, "----------------------------------------------------------------------------\n\n");

// Summary by newsletter (ACTUAL SENDS)
fwrite($fp, "ACTUAL EMAIL SENDS BY NEWSLETTER:\n");
fwrite($fp, "----------------------------------------------------------------------------\n");

$sendsByNewsletter = [];
foreach ($ACTUAL_SENDS as $event) {
    $nl = $event['newsletter'];
    if (!isset($sendsByNewsletter[$nl])) {
        $sendsByNewsletter[$nl] = [];
    }
    $sendsByNewsletter[$nl][] = $event;
}

foreach ($sendsByNewsletter as $newsletter => $events) {
    fwrite($fp, "\n$newsletter (" . count($events) . " sends):\n");
    foreach ($events as $event) {
        fwrite($fp, "  - " . $event['scheduledSendTime'] . " (" . $event['day'] . ")\n");
    }
}

// Summary by day (ACTUAL SENDS)
fwrite($fp, "\n\n");
fwrite($fp, "ACTUAL EMAIL SENDS BY DAY:\n");
fwrite($fp, "----------------------------------------------------------------------------\n");

$sendsByDay = [];
foreach ($ACTUAL_SENDS as $event) {
    $day = date('Y-m-d (l)', strtotime($event['scheduledSendTime']));
    if (!isset($sendsByDay[$day])) {
        $sendsByDay[$day] = [];
    }
    $sendsByDay[$day][] = $event;
}

ksort($sendsByDay);
foreach ($sendsByDay as $day => $events) {
    fwrite($fp, "\n$day:\n");
    foreach ($events as $event) {
        $time = date('H:i', strtotime($event['scheduledSendTime']));
        fwrite($fp, "  $time - " . $event['newsletter'] . "\n");
    }
}

// CUSTOM frequency updates summary
if (count($CUSTOM_UPDATES) > 0) {
    fwrite($fp, "\n\n");
    fwrite($fp, "CUSTOM FREQUENCY UPDATES (StartTime pushed forward):\n");
    fwrite($fp, "----------------------------------------------------------------------------\n");
    fwrite($fp, "These updates prevent Pinpoint from sending on non-scheduled days.\n\n");

    $customByNewsletter = [];
    foreach ($CUSTOM_UPDATES as $event) {
        $nl = $event['newsletter'];
        if (!isset($customByNewsletter[$nl])) {
            $customByNewsletter[$nl] = [];
        }
        $customByNewsletter[$nl][] = $event;
    }

    foreach ($customByNewsletter as $newsletter => $events) {
        fwrite($fp, "\n$newsletter (" . count($events) . " updates):\n");
        foreach ($events as $event) {
            fwrite($fp, "  - " . $event['timestamp'] . " (" . $event['day'] . ") -> StartTime pushed to " . $event['nextSendTime'] . "\n");
        }
    }
}

// Skip events summary
if (count($SKIP_EVENTS) > 0) {
    fwrite($fp, "\n\n");
    fwrite($fp, "SKIP EVENTS (no content):\n");
    fwrite($fp, "----------------------------------------------------------------------------\n");
    foreach ($SKIP_EVENTS as $event) {
        fwrite($fp, "  " . $event['timestamp'] . " - " . $event['newsletter'] . "\n");
    }
}

// Statistics
fwrite($fp, "\n\n");
fwrite($fp, "STATISTICS:\n");
fwrite($fp, "----------------------------------------------------------------------------\n");
fwrite($fp, "Total Newsletters: $newsletterCount\n");
fwrite($fp, "Total Actual Email Sends: " . count($ACTUAL_SENDS) . "\n");
fwrite($fp, "Total Pinpoint API Updates: " . count($PINPOINT_UPDATES) . "\n");
fwrite($fp, "Total CUSTOM Frequency Updates: " . count($CUSTOM_UPDATES) . "\n");
fwrite($fp, "Total Skip Events: " . count($SKIP_EVENTS) . "\n");
fwrite($fp, "Simulation Period: 7 days (" . number_format($totalMinutes) . " minutes)\n");
fwrite($fp, "\n");
fwrite($fp, "Average API Updates per Send: " . (count($ACTUAL_SENDS) > 0 ? round(count($PINPOINT_UPDATES) / count($ACTUAL_SENDS), 1) : 0) . "\n");
fwrite($fp, "(Expected: ~6 API updates per send due to 6-minute send window)\n");
fwrite($fp, "\n");
fwrite($fp, "CUSTOM frequency updates push StartTime forward on non-scheduled days,\n");
fwrite($fp, "preventing Pinpoint from sending on days not in the customFrequency array.\n");

fclose($fp);

// Print summary to console
echo "============================================================================\n";
echo "                              SUMMARY\n";
echo "============================================================================\n\n";

echo "Total Actual Email Sends: " . count($ACTUAL_SENDS) . "\n";
echo "Total Pinpoint API Updates: " . count($PINPOINT_UPDATES) . "\n";
echo "Total CUSTOM Frequency Updates: " . count($CUSTOM_UPDATES) . "\n";
echo "(API updates happen every minute in 6-min window; emails send once)\n\n";

echo "SENDS BY NEWSLETTER:\n";
foreach ($sendsByNewsletter as $newsletter => $events) {
    echo "  " . count($events) . "x - $newsletter\n";
}

echo "\nSENDS BY DAY:\n";
foreach ($sendsByDay as $day => $events) {
    echo "  " . count($events) . " sends on $day\n";
}

if (count($CUSTOM_UPDATES) > 0) {
    echo "\nCUSTOM FREQUENCY UPDATES (prevents weekend sends):\n";
    $customByNewsletter = [];
    foreach ($CUSTOM_UPDATES as $event) {
        $nl = $event['newsletter'];
        if (!isset($customByNewsletter[$nl])) {
            $customByNewsletter[$nl] = [];
        }
        $customByNewsletter[$nl][] = $event;
    }
    foreach ($customByNewsletter as $newsletter => $events) {
        echo "  " . count($events) . "x - $newsletter\n";
    }
}

if (count($SKIP_EVENTS) > 0) {
    echo "\nSKIP EVENTS: " . count($SKIP_EVENTS) . "\n";
}

echo "\n============================================================================\n";
echo "Full report written to: $outputFile\n";
echo "============================================================================\n";
