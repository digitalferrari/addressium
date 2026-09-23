<?php

// This script receives JSON data via POST, processes it, and sends an email report to specified recipients. It runs via cron job on the Swift/Ogden live server every Monday at 3am. It calls the endpoint on feederaws that sends the emails to classifieds staff.
function logMessage($message) {
    echo $message . PHP_EOL;

    // $logFile = __DIR__ . '/../logs/send_pinpoint_counts_to_classifieds_staff.log';
    // $timestamp = date('Y-m-d H:i:s');
    // file_put_contents($logFile, "[$timestamp] $message\n", FILE_APPEND);
}

logMessage("Script started");

// 1) Gather and combine all *.json files
$data = [];
if (!is_dir(__DIR__ . '/data')) {
    $error = "Data directory not found.";
    logMessage("ERROR: " . $error);
    fwrite(STDERR, $error . "\n");
    exit(1);
}

logMessage("Scanning data directory for JSON files");

foreach (glob(__DIR__ . '/data/*.json') as $file) {
    logMessage("Processing file: " . $file);
    $domain = pathinfo($file, PATHINFO_FILENAME);
    $raw   = file_get_contents($file);
    $json  = json_decode($raw, true);

    if (!is_array($json)) {
        logMessage("ERROR: Invalid JSON in file: " . $file);
        continue;
    }

    $list = [];
    foreach ($json as $segment) {
        $list[] = [
            'count' => (int) ($segment['count'] ?? 0),
            'name'  => $segment['name'] ?? '––unknown––'
        ];
    }

    $data[$domain] = $list;
    logMessage("Successfully processed domain: " . $domain);
}

// 2) POST to your endpoint
logMessage("Preparing to send data to endpoint");
$payload = json_encode($data, JSON_PRETTY_PRINT);

if (json_last_error() !== JSON_ERROR_NONE) {
    $error = "JSON encoding error: " . json_last_error_msg();
    logMessage("ERROR: " . $error);
    fwrite(STDERR, $error . "\n");
    exit(1);
}

$headers = [
    'Content-Type: application/json',
    'X-Swiftcom: swiftcom',
];

$epurl = 'https://feeder-aws.swiftcom.com/Tools/awspinpoint/email_list_counts_to_classifieds_staff.php';
logMessage("Sending POST request to: " . $epurl);

$ch = curl_init($epurl);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => $headers,
    CURLOPT_RETURNTRANSFER => true,
]);

$response = curl_exec($ch);

if ($err = curl_error($ch)) {
    logMessage("ERROR: cURL error: " . $err);
    fwrite(STDERR, "cURL error: $err\n");
    exit(1);
}

logMessage("Response received: " . $response);
curl_close($ch);

echo $response . PHP_EOL;
logMessage("Script completed");
