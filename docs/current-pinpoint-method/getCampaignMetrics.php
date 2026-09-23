<?php

ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

ini_set('memory_limit','2048M');
date_default_timezone_set('America/Denver');
load_global_config($argv[1]);

function global_config($key) {
  $args = func_get_args();
  static $configsettings;
  if($configsettings == null) {
    $configsettings = array();
  }
  if(count($args) >= 2) {
    $configsettings[$key] = $args[1];
    return null;
  } else {
    return array_key_exists($key, $configsettings) ? $configsettings[$key] : null;
  }
}

function load_global_config($configLoc) {
  $configlocation = 'sdConfig.ini';
  $configlocation = $configLoc;
  if(!is_file($configlocation)) {
    throw new Exception("$configlocation not found, please create an ini file with this name.\n");
  }
  $config = parse_ini_file($configlocation);
  if($config === false) {
    throw new Exception("Could not parse $configlocation as an ini file.");
  }
  foreach($config as $key => $value) {
    global_config($key, $value);
  }
}



$server = global_config('wpServer');
$username = global_config('wpUsername');
$password = global_config('wpPassword');
$dbname = global_config('wpDB');
$port = "3306";
$socket = "/Users/tcovert/Library/Application Support/Local/run/HGofzX-s7/mysql/mysqld.sock";
// Create connection
$conn = new mysqli($server, $username, $password, $dbname, $port, $socket);
// Check connection
if ($conn->connect_error) {
    die("Connection failed: " . $conn->connect_error);
} 

$dataServer = global_config('sqlServer');
$dataUsername = global_config('sqlUsername');
$dataPassword = global_config('sqlPassword');
$dataDBname = global_config('pinpointDB');
$dataPort = "3306";
// Create connection
$connection = new mysqli($dataServer, $dataUsername, $dataPassword, $dataDBname, $dataPort);
// Check connection
if ($connection->connect_error) {
    die("Connection failed: " . $connection->connect_error);
} 



// require '/www/feeder.swiftcom.com/processors/AWS/vendor/autoload.php';
require '../vendor/autoload.php';

use Aws\Credentials\Credentials;
use Aws\Pinpoint\PinpointClient;
$credentials = new Credentials('REMOVED', 'REMOVED');
$client = new PinpointClient([
    'version' => 'latest',
    'region' => 'us-west-2',
    'credentials' => $credentials
]);

$result = $client->getCampaignActivities([
    'ApplicationId' => global_config('pinAppID'), // REQUIRED
    'CampaignId' => 'c2030d4ea1af4d81b79d1be6c6911776', // REQUIRED
    'PageSize' => '100',
    // 'Token' => '<string>',
]);




print_r($result);



$items = $result['ActivitiesResponse']['Item'];

foreach ($items as $item) {
    $site = 'SD'; // Assuming the 'Site' value is constant for all items
    $campaignName = 'Daily Headlines'; // Assuming the 'CampaignName' value is constant for all items
    
    $applicationId = $item['ApplicationId'];
    $campaignId = $item['CampaignId'];
    $end = date('Y-m-d H:i:s', strtotime($item['End']));
    $id = $item['Id'];
    $result = $item['Result'];
    $scheduledStart = date('Y-m-d H:i:s', strtotime($item['ScheduledStart']));
    $start = date('Y-m-d H:i:s', strtotime($item['Start']));
    $state = $item['State'];
    $successfulEndpointCount = $item['SuccessfulEndpointCount'];
    $totalEndpointCount = $item['TotalEndpointCount'];
    $treatmentId = $item['TreatmentId'];

    // Prepare the SQL statement
    $sql = "INSERT INTO pinpointCampaignActivity 
            (Site, CampaignName, ApplicationId, CampaignId, End, Id, Result, ScheduledStart, Start, State, SuccessfulEndpointCount, TotalEndpointCount, TreatmentId) 
            VALUES 
            ('$site', '$campaignName', '$applicationId', '$campaignId', '$end', '$id', '$result', '$scheduledStart', '$start', '$state', '$successfulEndpointCount', '$totalEndpointCount', '$treatmentId')
            ON DUPLICATE KEY UPDATE
            Site = VALUES(Site), CampaignName = VALUES(CampaignName), ApplicationId = VALUES(ApplicationId),
            CampaignId = VALUES(CampaignId), End = VALUES(End), Id = VALUES(Id), Result = VALUES(Result),
            ScheduledStart = VALUES(ScheduledStart), Start = VALUES(Start), State = VALUES(State),
            SuccessfulEndpointCount = VALUES(SuccessfulEndpointCount), TotalEndpointCount = VALUES(TotalEndpointCount),
            TreatmentId = VALUES(TreatmentId)";
    echo $sql . "\n";
    // Execute the SQL statement
    $sqlResult = mysqli_query($connection, $sql);
    
    // Check for errors
    if (!$sqlResult) {
        echo "Error: " . mysqli_error($connection);
    }
}










// $campaignSQL = "SELECT * FROM pinpointCampaignActivity where ScheduleStart >= '".date('Y-m-d H:i:s',strtotime('-8 days'))."'";
// $campaignResult = mysqli_query($connection, $campaignSQL);
// if (!$campaignResult) {
//     echo "Error: " . mysqli_error($connection);
// }
// while($campaignRow = mysqli_fetch_assoc($campaignResult)){
    // $campaignArray[] = $campaignRow;



// $metricArray = array('hard-bounce-rate-grouped-by-campaign-activity','successful-delivery-rate-grouped-by-campaign-activity','email-open-rate-grouped-by-campaign-activity','direct-email-opens-grouped-by-campaign-activity','unique-deliveries-grouped-by-campaign-activity','clicks-grouped-by-campaign-activity','successful-deliveries-grouped-by-campaign-activity','attempted-deliveries-grouped-by-campaign-activity');

// foreach($metricArray as $metric){

//     $result = $client->getCampaignDateRangeKpi([
//         'ApplicationId' => global_config('pinAppID'), // REQUIRED
//         'CampaignId' => $campaignRow['CampaignId], // REQUIRED
//         'KpiName' => $metric, // REQUIRED
//         'PageSize' => '100',
//         // 'NextToken' => '<string>',
//         // 'EndTime' => '<string>',
//         // 'StartTime' => '<string>',
//     ]);    

//     // Loop through the objects and insert/update data into the table
//     foreach ($result['CampaignDateRangeKpiResponse']['KpiResult']['Rows'] as $row) {
//         $campaignActivityId = $row['GroupedBys'][0]['Value'];

//         // Extract and prepare the values for the INSERT statement
//         $values = [];
//         $keys = [];
//         $updateValues = [];
//         foreach ($row['Values'] as $value) {
//             $key = $value['Key'];
//             $val = $value['Value'];
//             $updateValues[] = "$key = $val";
//             $values[] = "$val";
//             $keys[] = $key;
//         }
//         $valuesString = implode(', ', $values);
//         $keysString = implode(', ', $keys);
//         $updateValuesString = implode(', ', $updateValues);

//     echo $valuesString . "\n";

//         // Construct the INSERT INTO ... ON DUPLICATE KEY UPDATE statement
//         $metricSQL = "INSERT INTO pinpointActivityMetrics (CampaignActivityId, $keysString) 
//                 VALUES ('$campaignActivityId', $valuesString)
//                 ON DUPLICATE KEY UPDATE $updateValuesString";

//         echo $metricSQL . "\n";

//         // Execute the query
//         if ($connection->query($metricSQL) === TRUE) {
//             echo "Record inserted/updated successfully for CampaignActivityId: $campaignActivityId\n";
//         } else {
//             echo "Error: " . $metricSQL . "\n" . $connection->error;
//         }
//     }



// }


// }