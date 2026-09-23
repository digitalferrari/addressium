<?php
// require 'vendor/autoload.php';
require '/usr/web/swiftcron-scripts/vendor/autoload.php';
use Aws\Pinpoint\PinpointClient;
use Aws\S3\S3Client;
use Aws\Exception\AwsException;

ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

ini_set("log_errors", 1);
ini_set("error_log", "/usr/web/swiftcron-scripts/logs/php-error.log");

ini_set('memory_limit','2048M');
date_default_timezone_set('America/Denver');

$startTime = microtime(true);
date_default_timezone_set('America/Denver');

echo "Script started at: " . date('Y-m-d H:i:s T') . "\n";

// --- Configuration ---

$all_pubs_pinpoint_projects_for_list_management = [
    'tsln' => '06c58518d59b4f848a8d8e954ad674b3',
    'tfp' => '910f82f925e9436f8759183d81008142',
    'swiftdev' => 'afad7dddd331448e84f9d770625bd94d',
    'swiftmulti' => '25a92f1b459446e080b3a92ac3b01c6f',
    'vdn' => '8992571538da4cd7ad1f2dbbc910d432',
    'atd' => '721e70d9a11048a988f5bab093158787',
    'tdt' => 'c8554a4df3c64f45ace359958c7ef641',
    'sdn' => '8ffae20f8d4a4e0592fc90dad58b05c3',
    'sbt' => 'c0667d2e00e5430ebabd2c38cb3b4f98',
    'shn' => '74c795100a5d49a59185ab169317df20',
    'ssu' => '40021cd03c964ca693d797b6047ea0eb',
    'tpr' => '40594ae438304bc48eb3ecbad8ed14bb',
    'gspi' => 'c2b6dc11db9e40c4904da3738b1f7876',
    'cdp' => '4517e47881b5453381a1587bfe5127f7'
];

// --- Argument Parsing ---
if (isset($argv[1])) {
    $projectName = $argv[1];
} else {
    echo "ERROR: Please provide a project name as an argument.\n";
    // --- Script End Time & Duration ---
    $endTime = microtime(true);
    $duration = round($endTime - $startTime, 2);
    echo "\nScript finished at: " . date('Y-m-d H:i:s T') . "\n";
    echo "Total execution time: " . $duration . " seconds.\n";
    exit(1);
}
if (!array_key_exists($projectName, $all_pubs_pinpoint_projects_for_list_management)) {
    echo "ERROR: Invalid project name provided: '$projectName'.\n";
    echo "Available projects are: " . implode(', ', array_keys($all_pubs_pinpoint_projects_for_list_management)) . "\n";
    // --- Script End Time & Duration ---
    $endTime = microtime(true);
    $duration = round($endTime - $startTime, 2);
    echo "\nScript finished at: " . date('Y-m-d H:i:s T') . "\n";
    echo "Total execution time: " . $duration . " seconds.\n";
    exit(1);
}
// Set the Application ID based on the provided project name
$applicationId = $all_pubs_pinpoint_projects_for_list_management[$projectName];
echo "Processing project: '$projectName' (Application ID: $applicationId)\n";

// --- AWS & Job Configuration ---
$awsRegion = 'us-west-2';
$s3BucketName = 'swift-pinpoint-export-92c6b3g879ol4swb'; // <-- Replace with your S3 bucket name if needed
$s3ExportPrefix = 'pinpoint-segment-exports/'; // Optional: Specify a folder within the bucket for exports

// ** AWS Credentials for Script Authentication **
// !! IMPORTANT: Replace these test credentials with your actual secure credentials !!
// Consider using environment variables or a more secure credential management system.
$awsAccessKeyId = 'REMOVED';
$awsSecretAccessKey = 'REMOVED';


// ** IAM Role ARN for Pinpoint Service **
// This role is assumed BY PINPOINT SERVICE to write to S3 during the export job.
// It is required by the createExportJob API call, even when the script uses keys/secrets.
$iamRoleArn = 'arn:aws:iam::857142565930:role/PinpointExport'; // <-- Replace with your IAM Role ARN if needed

// Construct the output file path using the project name
// This corresponds to the pattern /usr/web/swiftcron-scripts/data/${filenamePath}
// assuming the script runs from /usr/web/swiftcron-scripts/
$outputFilePath = __DIR__ . '/data/' . $projectName . '_pinpoint_segment_counts.json';
echo "Output file path: $outputFilePath\n";
$tempDir = sys_get_temp_dir();

// S3 Cleanup
$cleanupS3 = true; // Set to true to delete export files from S3 after counting, false to keep them

// Polling configuration
$pollIntervalSeconds = 30; // How often to check export job status (seconds)
$maxPollAttempts = 40; // Max attempts before timing out (30s * 40 = 20 minutes)

// Run Frequency Check
$minHoursBetweenRuns = 23; // Minimum hours required since last successful run

// --- Initialization ---
echo "Starting Pinpoint segment count process for '$projectName'...\n";

// --- Check Last Run Time ---
echo "Checking last run time...\n";
$proceedWithRun = true; // Assume we run unless check says otherwise

if (file_exists($outputFilePath)) {
    echo "  Output file found: $outputFilePath\n";
    try {
        $jsonContent = file_get_contents($outputFilePath);
        if ($jsonContent === false) {
             // Handle file read error explicitly
             echo "  WARNING: Could not read output file '$outputFilePath'. Proceeding with run.\n";
        } else {
            $lastRunData = json_decode($jsonContent, true); // Decode as associative array

            if (json_last_error() === JSON_ERROR_NONE && !empty($lastRunData)) {
                $latestTimestamp = 0;
                // Find the most recent timestamp across all segments in the file
                foreach ($lastRunData as $segmentData) {
                    if (isset($segmentData['last_updated_utc'])) {
                        // Use strtotime to handle potential variations, fallback to 0 on failure
                        $segmentTimestamp = strtotime($segmentData['last_updated_utc']) ?: 0;
                        if ($segmentTimestamp > $latestTimestamp) {
                            $latestTimestamp = $segmentTimestamp;
                        }
                    }
                }

                if ($latestTimestamp > 0) {
                    $lastRunDateTime = new DateTime("@$latestTimestamp"); // Create DateTime from Unix timestamp
                    $lastRunDateTime->setTimezone(new DateTimeZone('UTC')); // Ensure UTC
                    $nowDateTime = new DateTime('now', new DateTimeZone('UTC'));
                    $diffSeconds = $nowDateTime->getTimestamp() - $lastRunDateTime->getTimestamp();
                    $diffHours = $diffSeconds / 3600; // Calculate difference in hours

                    echo "  Last successful run finished at: " . $lastRunDateTime->format('Y-m-d H:i:s T') . "\n";
                    echo "  Current time: " . $nowDateTime->format('Y-m-d H:i:s T') . "\n";
                    echo "  Hours since last run: " . round($diffHours, 2) . "\n";

                    if ($diffHours < $minHoursBetweenRuns) {
                        echo "  Skipping run: Less than $minHoursBetweenRuns hours have passed since the last successful run.\n";
                        $proceedWithRun = false;
                        // --- Script End Time & Duration ---
                        $endTime = microtime(true);
                        $duration = round($endTime - $startTime, 2);
                        echo "\nScript finished at: " . date('Y-m-d H:i:s T') . "\n";
                        echo "Total execution time: " . $duration . " seconds.\n";
                        exit(0); // Exit gracefully - no need to proceed
                    } else {
                        echo "  Proceeding with run: Minimum interval of $minHoursBetweenRuns hours has passed.\n";
                    }
                } else {
                    echo "  WARNING: Could not determine a valid latest timestamp from the existing file. Proceeding with run.\n";
                }
            } else {
                echo "  WARNING: Output file is empty or contains invalid JSON (Error: " . json_last_error_msg() . "). Proceeding with run.\n";
            }
        }
    } catch (\Exception $e) {
        // If we can't read/parse the file, it's safer to proceed with the run
        echo "  WARNING: Error reading or parsing output file '$outputFilePath': " . $e->getMessage() . ". Proceeding with run.\n";
    }
} else {
    echo "  Output file not found. Proceeding with first run (or run after file deletion).\n";
}

// --- Proceed only if check passed ---
// This check is technically redundant because of the exit(0) above, but kept for clarity
if (!$proceedWithRun) {
    echo "Exiting script as per time check (This should not be reached).\n";
    // --- Script End Time & Duration ---
    $endTime = microtime(true);
    $duration = round($endTime - $startTime, 2);
    echo "\nScript finished at: " . date('Y-m-d H:i:s T') . "\n";
    echo "Total execution time: " . $duration . " seconds.\n";
    exit(0);
}

// --- AWS SDK Initialization ---
echo "Initializing AWS SDK with Access Key...\n";
$sdkConfig = [
    'region' => $awsRegion,
    'version' => 'latest',
    'credentials' => [ // Use provided Access Key and Secret Key
        'key'    => $awsAccessKeyId,
        'secret' => $awsSecretAccessKey,
    ],
];

try {
    $pinpointClient = new PinpointClient($sdkConfig);
    $s3Client = new S3Client($sdkConfig);
    echo "AWS SDK initialized successfully using provided credentials.\n";
} catch (\Exception $e) {
    echo "FATAL: Error initializing AWS SDK: " . $e->getMessage() . "\n";
    // --- Script End Time & Duration ---
    $endTime = microtime(true);
    $duration = round($endTime - $startTime, 2);
    echo "\nScript finished at: " . date('Y-m-d H:i:s T') . "\n";
    echo "Total execution time: " . $duration . " seconds.\n";
    exit(1);
}

$allSegmentCounts = [];

// --- Main Logic ---

try {
    // 1. Get List of Segments (Live data from Pinpoint API)
    echo "Fetching segments for Application ID: $applicationId\n";
    $segmentsResult = $pinpointClient->getSegments([
        'ApplicationId' => $applicationId,
    ]);

    $segments = $segmentsResult['SegmentsResponse']['Item'] ?? [];

    if (empty($segments)) {
        echo "No segments found for this application.\n";
        // Ensure the output directory exists before writing
        $outputDir = dirname($outputFilePath);
        if (!is_dir($outputDir)) {
            if (!mkdir($outputDir, 0755, true)) {
                 echo "ERROR: Failed to create output directory: $outputDir\n";
                 // --- Script End Time & Duration ---
                 $endTime = microtime(true);
                 $duration = round($endTime - $startTime, 2);
                 echo "\nScript finished at: " . date('Y-m-d H:i:s T') . "\n";
                 echo "Total execution time: " . $duration . " seconds.\n";
                 exit(1);
            }
        }
        if (file_put_contents($outputFilePath, json_encode([], JSON_PRETTY_PRINT)) === false) {
             echo "ERROR: Failed to write empty results to $outputFilePath\n";
             // --- Script End Time & Duration ---
             $endTime = microtime(true);
             $duration = round($endTime - $startTime, 2);
             echo "\nScript finished at: " . date('Y-m-d H:i:s T') . "\n";
             echo "Total execution time: " . $duration . " seconds.\n";
             exit(1);
        }
        echo "Wrote empty result set to $outputFilePath.\n";
        // --- Script End Time & Duration ---
        $endTime = microtime(true);
        $duration = round($endTime - $startTime, 2);
        echo "\nScript finished successfully at: " . date('Y-m-d H:i:s T') . "\n";
        echo "Total execution time: " . $duration . " seconds.\n";
        exit(0);
    }

    echo "Found " . count($segments) . " segments.\n";

    // 2. Process Each Segment
    foreach ($segments as $segment) {
        $segmentId = $segment['Id'];
        $segmentName = $segment['Name'] ?? 'Unnamed Segment'; // Use Name for logging if available
        echo "\nProcessing Segment: '$segmentName' (ID: $segmentId)\n";

        $currentSegmentCount = -1; // Default to -1 indicating an issue or incomplete process
        $exportJobId = null;
        $localTempFilePath = null; // Reset for each segment

        try {
            // 3. Create Export Job
            // Define a unique path per segment export using only the segment ID under the prefix
            $exportS3PathPrefix = rtrim($s3ExportPrefix, '/') . '/' . $segmentId;
            $s3UrlPrefix = 's3://' . rtrim($s3BucketName, '/') . '/' . $exportS3PathPrefix;

            echo "  Creating export job to prefix: $s3UrlPrefix/\n";
            $exportJobResult = $pinpointClient->createExportJob([
                'ApplicationId' => $applicationId,
                'ExportJobRequest' => [
                    // RoleArn is REQUIRED here: It's the role Pinpoint service assumes to write to S3.
                    'RoleArn' => $iamRoleArn,
                    'S3UrlPrefix' => $s3UrlPrefix, // Pinpoint will add job ID and file names under this
                    'SegmentId' => $segmentId,
                    // 'SegmentVersion' => $segment['SegmentVersion'], // Optional: Use specific version if needed
                ],
            ]);

            $exportJobId = $exportJobResult['ExportJobResponse']['Id'];
            $jobDefinition = $exportJobResult['ExportJobResponse']; // Keep for potential debugging
            echo "  Export Job created with ID: $exportJobId\n";

            // 4. Poll for Export Job Completion
            echo "  Polling job status (Max attempts: $maxPollAttempts, Interval: {$pollIntervalSeconds}s)...\n";
            $attempts = 0;
            $jobStatus = null;
            $jobCompleted = false;
            $jobFailed = false;

            do {
                sleep($pollIntervalSeconds);
                $attempts++;
                echo "  Attempt $attempts/$maxPollAttempts: Checking status for Job ID $exportJobId...\n";

                $jobStatusResult = $pinpointClient->getExportJob([
                    'ApplicationId' => $applicationId,
                    'JobId' => $exportJobId,
                ]);

                $jobStatus = $jobStatusResult['ExportJobResponse']['JobStatus'];
                $jobDefinition = $jobStatusResult['ExportJobResponse']; // Update with latest status/info
                echo "    Current Status: $jobStatus\n";

                if ($jobStatus === 'COMPLETED') {
                    $jobCompleted = true;
                    echo "  Export job completed successfully.\n";
                    break; // Exit polling loop
                } elseif (in_array($jobStatus, ['FAILED', 'CANCELLED'])) {
                    $jobFailed = true;
                    echo "  ERROR: Export job failed or was cancelled (Status: $jobStatus).\n";
                    // Log failure reason if available
                    if (!empty($jobDefinition['FailureInfo'])) {
                         echo "    Failure Info: " . $jobDefinition['FailureInfo'] . "\n";
                    }
                    break; // Exit polling loop
                } elseif ($attempts >= $maxPollAttempts) {
                    echo "  ERROR: Export job polling timed out after $attempts attempts (Status: $jobStatus). Skipping count.\n";
                    break; // Exit polling loop
                }

            } while (true);


            // 5. Download and Count if Job Completed Successfully
            if ($jobCompleted) {
                $currentSegmentCount = 0; // Initialize count for this segment
                $foundGzFiles = false; // Flag to track if we processed any files

                // List objects under the specific job's output path.
                // Pinpoint typically creates files like: s3://<bucket>/<prefix>/<segment_id>/<job_id>-<part>.gz
                // However, let's list under the segment ID prefix and filter for .gz files,
                // assuming the cleanup works reliably or we only care about the latest job's files.
                // A more robust approach might involve parsing jobDefinition['S3UrlPrefix'] if needed,
                // but listing under segment ID is common practice.
                $listPrefix = $exportS3PathPrefix . '/'; // e.g., pinpoint-segment-exports/segment-id-123/
                echo "  Listing objects in s3://{$s3BucketName}/{$listPrefix} to count parts\n";

                try {
                    $listPaginator = $s3Client->getPaginator('ListObjectsV2', [
                        'Bucket' => $s3BucketName,
                        'Prefix' => $listPrefix,
                    ]);

                    foreach ($listPaginator as $listResult) {
                        if (!empty($listResult['Contents'])) {
                            foreach ($listResult['Contents'] as $object) {
                                // Check if the object is a gzipped file
                                if (substr($object['Key'], -3) === '.gz') {
                                    $foundGzFiles = true;
                                    $s3ObjectKey = $object['Key'];
                                    $localTempFilePath = $tempDir . '/' . uniqid('pinpoint_export_part_') . '.gz'; // Use unique temp name

                                    echo "    Processing export part: $s3ObjectKey\n";

                                    try {
                                        echo "      Downloading s3://{$s3BucketName}/{$s3ObjectKey} to $localTempFilePath\n";
                                        $s3Client->getObject([
                                            'Bucket' => $s3BucketName,
                                            'Key' => $s3ObjectKey,
                                            'SaveAs' => $localTempFilePath,
                                        ]);

                                        echo "      Download complete. Counting lines...\n";

                                        // Count lines in this gzipped file part
                                        $partLineCount = 0;
                                        $handle = gzopen($localTempFilePath, 'r');
                                        if ($handle) {
                                            while (fgets($handle) !== false) {
                                                $partLineCount++;
                                            }
                                            gzclose($handle);
                                            echo "      Count for this part: $partLineCount\n";
                                            $currentSegmentCount += $partLineCount; // Add to the total segment count
                                        } else {
                                            echo "      ERROR: Could not open gzipped file: $localTempFilePath\n";
                                            // Treat this part as failed, but continue processing others.
                                            // Consider if this should invalidate the total count (set to -1). For now, just log.
                                        }

                                    } catch (AwsException $e) {
                                        echo "      ERROR (AWS): Failed downloading/processing part $s3ObjectKey: " . $e->getAwsErrorMessage() . " (Code: " . $e->getAwsErrorCode() . ")\n";
                                        // If a part fails, maybe invalidate the total count?
                                        $currentSegmentCount = -1; // Invalidate total count if any part fails
                                        break 2; // Break out of both inner loops (object and paginator)
                                    } catch (\Exception $e) {
                                        echo "      ERROR (General): Failed processing part $s3ObjectKey: " . $e->getMessage() . "\n";
                                        $currentSegmentCount = -1; // Invalidate total count if any part fails
                                        break 2; // Break out of both inner loops
                                    } finally {
                                        // Cleanup temporary file for this part
                                        if ($localTempFilePath && file_exists($localTempFilePath)) {
                                            echo "      Cleaning up temporary file: $localTempFilePath\n";
                                            unlink($localTempFilePath);
                                            $localTempFilePath = null; // Reset for next part
                                        }
                                    }
                                } // End if .gz
                            } // End foreach object in listResult
                        } // End if !empty listResult
                    } // End foreach paginator result

                    if (!$foundGzFiles) {
                         echo "  WARNING: Export job completed, but no .gz files found under prefix '$listPrefix'. Setting count to 0.\n";
                         $currentSegmentCount = 0; // Set count to 0 if job completed but no files found
                    } elseif ($currentSegmentCount >= 0) { // Check if count wasn't invalidated by errors
                        echo "  Total count for segment $segmentId (sum of all parts): $currentSegmentCount\n";
                    } else {
                        echo "  Count for segment $segmentId is invalid due to processing errors.\n";
                    }

                } catch (AwsException $e) {
                     echo "  ERROR (AWS): Failed listing S3 objects under prefix '$listPrefix': " . $e->getAwsErrorMessage() . " (Code: " . $e->getAwsErrorCode() . ")\n";
                     $currentSegmentCount = -1; // Failed to list, cannot count
                } catch (\Exception $e) {
                     echo "  ERROR (General): Failed listing S3 objects under prefix '$listPrefix': " . $e->getMessage() . "\n";
                     $currentSegmentCount = -1; // Failed to list, cannot count
                }

            } else { // Job did not complete successfully (failed, cancelled, or timed out)
                 echo "  Export job did not complete successfully (Status: " . ($jobStatus ?? 'Unknown') . "). Skipping count.\n";
                 $currentSegmentCount = -1; // Ensure count is -1
            }

        } catch (AwsException $e) {
            echo "  ERROR (AWS): Failed processing segment $segmentId: " . $e->getAwsErrorMessage() . " (Code: " . $e->getAwsErrorCode() . ")\n";
            if ($e->getAwsRequestId()) {
                 echo "    Request ID: " . $e->getAwsRequestId() . "\n";
            }
            $currentSegmentCount = -1; // Ensure count is -1 on error
        } catch (\Exception $e) {
            echo "  ERROR (General): Failed processing segment $segmentId: " . $e->getMessage() . "\n";
            $currentSegmentCount = -1; // Ensure count is -1 on error
        } finally {
            // 6. Store Result for this Segment (using the final $currentSegmentCount)
            $allSegmentCounts[$segmentId] = [
                'name' => $segmentName,
                'id' => $segmentId,
                'count' => $currentSegmentCount, // Holds the sum, 0, or -1
                'last_updated_utc' => date('Y-m-d H:i:s') // Timestamp of when this script processed it
            ];

            // 7. Cleanup S3 Export Files (if enabled and job didn't fail catastrophically before polling)
            // We attempt cleanup even if counting failed, as long as the job *might* have created files.
            // We use the $exportJobId which is only set if createExportJob succeeded.
            // We also check the $cleanupS3 flag.
            if ($cleanupS3 && $exportJobId) {
                // Cleanup everything under the segment prefix. This assumes old job files aren't needed.
                // If multiple jobs run close together without cleanup, this could delete files
                // from a job that hasn't been fully processed yet by another instance, though unlikely
                // with the frequency check.
                $deletePrefix = rtrim($s3ExportPrefix, '/') . '/' . $segmentId . '/';
                echo "  Attempting S3 cleanup for prefix: s3://{$s3BucketName}/{$deletePrefix}\n";
                try {
                    $objectsToDelete = [];
                    $deletePaginator = $s3Client->getPaginator('ListObjectsV2', [
                        'Bucket' => $s3BucketName,
                        'Prefix' => $deletePrefix
                    ]);

                    $objectKeys = []; // Collect keys for batch deletion
                    foreach ($deletePaginator as $listResult) {
                         if (!empty($listResult['Contents'])) {
                            foreach ($listResult['Contents'] as $object) {
                                $objectKeys[] = ['Key' => $object['Key']];
                            }
                        }
                    }

                    if (!empty($objectKeys)) {
                        $totalToDelete = count($objectKeys);
                        echo "    Found $totalToDelete objects to delete under prefix '$deletePrefix'. Processing in chunks...\n";

                        // deleteObjects can handle up to 1000 keys per request.
                        $chunks = array_chunk($objectKeys, 1000);
                        $totalDeleted = 0;
                        $totalErrors = 0;

                        foreach ($chunks as $chunkIndex => $chunk) {
                            echo "      Deleting chunk " . ($chunkIndex + 1) . "/" . count($chunks) . " (" . count($chunk) . " objects)\n";
                            $deleteResult = $s3Client->deleteObjects([
                                'Bucket' => $s3BucketName,
                                'Delete' => [
                                    'Objects' => $chunk,
                                    'Quiet' => false, // Get error details back
                                ],
                            ]);

                            if (!empty($deleteResult['Deleted'])) {
                                $totalDeleted += count($deleteResult['Deleted']);
                                // foreach ($deleteResult['Deleted'] as $deleted) { echo "Deleted: {$deleted['Key']}\n"; } // Verbose
                            }

                            if (!empty($deleteResult['Errors'])) {
                                $chunkErrors = count($deleteResult['Errors']);
                                $totalErrors += $chunkErrors;
                                echo "      WARNING: $chunkErrors errors occurred during S3 deletion chunk " . ($chunkIndex + 1) . ":\n";
                                foreach ($deleteResult['Errors'] as $error) {
                                    echo "        - Key: {$error['Key']}, Code: {$error['Code']}, Message: {$error['Message']}\n";
                                }
                            }
                        } // End foreach chunk

                        echo "    S3 cleanup summary for prefix '$deletePrefix': $totalDeleted deleted, $totalErrors errors.\n";

                    } else {
                        echo "    No objects found under prefix '{$deletePrefix}' to delete.\n";
                    }

                } catch (AwsException $e) {
                    echo "  ERROR (AWS): Failed during S3 cleanup for prefix $deletePrefix: " . $e->getAwsErrorMessage() . " (Code: " . $e->getAwsErrorCode() . ")\n";
                     if ($e->getAwsRequestId()) { echo "    Request ID: " . $e->getAwsRequestId() . "\n"; }
                } catch (\Exception $e) {
                    echo "  ERROR (General): Failed during S3 cleanup for prefix $deletePrefix: " . $e->getMessage() . "\n";
                }
            } elseif ($cleanupS3) {
                 echo "  Skipping S3 cleanup for segment $segmentId (Reason: Export job creation likely failed or cleanup disabled).\n";
            }
            // Local temporary file cleanup is handled within the file processing loop itself.

        } // End finally block for segment processing
    } // End foreach segment

    // 8. Write Final Results to File
    echo "\nWriting final counts to: $outputFilePath\n";
    // Ensure output directory exists
    $outputDir = dirname($outputFilePath);
    if (!is_dir($outputDir)) {
        if (!mkdir($outputDir, 0755, true)) {
             echo "ERROR: Failed to create output directory: $outputDir\n";
             // --- Script End Time & Duration ---
             $endTime = microtime(true);
             $duration = round($endTime - $startTime, 2);
             echo "\nScript finished at: " . date('Y-m-d H:i:s T') . "\n";
             echo "Total execution time: " . $duration . " seconds.\n";
             exit(1);
        }
    }

    $jsonOutput = json_encode($allSegmentCounts, JSON_PRETTY_PRINT);
    if (file_put_contents($outputFilePath, $jsonOutput) === false) {
        echo "ERROR: Failed to write results to $outputFilePath\n";
        // --- Script End Time & Duration ---
        $endTime = microtime(true);
        $duration = round($endTime - $startTime, 2);
        echo "\nScript finished at: " . date('Y-m-d H:i:s T') . "\n";
        echo "Total execution time: " . $duration . " seconds.\n";
        exit(1); // Exit with error status if file write fails
    }

    echo "\nProcess completed successfully for project '$projectName'.\n";
    // --- Script End Time & Duration ---
    $endTime = microtime(true);
    $duration = round($endTime - $startTime, 2);
    echo "\nScript finished successfully at: " . date('Y-m-d H:i:s T') . "\n";
    echo "Total execution time: " . $duration . " seconds.\n";
    exit(0); // Success

} catch (AwsException $e) {
    echo "\nFATAL AWS Error during script execution:\n";
    echo "  Message: " . $e->getAwsErrorMessage() . "\n";
    echo "  AWS Error Code: " . $e->getAwsErrorCode() . "\n";
    if ($e->getAwsRequestId()) {
         echo "  Request ID: " . $e->getAwsRequestId() . "\n";
    }
    // Optional: Add $e->getTraceAsString() if more detail is needed for debugging
    // echo "  Trace: " . $e->getTraceAsString() . "\n";
    // --- Script End Time & Duration ---
    $endTime = microtime(true);
    $duration = round($endTime - $startTime, 2);
    echo "\nScript finished with errors at: " . date('Y-m-d H:i:s T') . "\n";
    echo "Total execution time: " . $duration . " seconds.\n";
    exit(1);
} catch (\Exception $e) {
    echo "\nFATAL General Error during script execution:\n";
    echo "  Message: " . $e->getMessage() . "\n";
    echo "  File: " . $e->getFile() . " on line " . $e->getLine() . "\n";
    // Optional: Add $e->getTraceAsString()
    // echo "  Trace: " . $e->getTraceAsString() . "\n";
    // --- Script End Time & Duration ---
    $endTime = microtime(true);
    $duration = round($endTime - $startTime, 2);
    echo "\nScript finished with errors at: " . date('Y-m-d H:i:s T') . "\n";
    echo "Total execution time: " . $duration . " seconds.\n";
    exit(1);
}