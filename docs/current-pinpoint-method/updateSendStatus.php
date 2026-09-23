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
// $socket = "/Users/tcovert/Library/Application Support/Local/run/HGofzX-s7/mysql/mysqld.sock";
// Create connection
$conn = new mysqli($server, $username, $password, $dbname, $port);
// Check connection
if ($conn->connect_error) {
    die("Connection failed: " . $conn->connect_error);
} 


// require '/www/feeder.swiftcom.com/processors/AWS/vendor/autoload.php';
require '/usr/web/swiftcron-scripts/vendor/autoload.php';


use Aws\Pinpoint\PinpointClient;
use Aws\Credentials\Credentials;

$credentials = new Credentials('REMOVED', 'REMOVED');

$client = new PinpointClient([
    'version' => 'latest',
    'region' => 'us-west-2',
    'credentials' => $credentials
]);

function getCampaign($campaignID) {
    global $client;
    $response = $client->getCampaign([
        'ApplicationId' => global_config('pinAppID'), // REQUIRED
        'CampaignId' => $campaignID, // REQUIRED
    ]);
    // print_r($response);
    return $response;
}



$oneTimeSendsSQL = "SELECT * FROM `".global_config('wpTablePrefix')."aws_pinpoint_once_sends` WHERE `campaignStatus` != 'COMPLETED' and `campaignID` != ''";
$oneTimeSendsResult = $conn->query($oneTimeSendsSQL);
while($otRow = $oneTimeSendsResult->fetch_assoc()) {
    $campaignDetails = getCampaign($otRow['campaignID']);
    $campaignStatus = $campaignDetails['CampaignResponse']['State']['CampaignStatus'];

    if($campaignStatus != $otRow['campaignStatus']) {
        $updateSQL = "UPDATE `".global_config('wpTablePrefix')."aws_pinpoint_once_sends` SET `campaignStatus` = '".$campaignStatus."' WHERE `campaignID` = '".$otRow['campaignID']."'";
        $updateResult = $conn->query($updateSQL);
    }
}



$newsletterSendsSQL = "SELECT * FROM `".global_config('wpTablePrefix')."aws_pinpoint_newsletter_schedules` WHERE `campaignStatus` != 'COMPLETED' and `campaignID` != ''";
$newsSendsResult = $conn->query($newsletterSendsSQL);
while($newsRow = $newsSendsResult->fetch_assoc()) {
    $newsDetails = getCampaign($newsRow['campaignID']);
    $newsStatus = $newsDetails['CampaignResponse']['State']['CampaignStatus'];

    if($newsStatus != $newsRow['campaignStatus']) {
        $updateNewsSQL = "UPDATE `".global_config('wpTablePrefix')."aws_pinpoint_newsletter_schedules` SET `campaignStatus` = '".$newsStatus."' WHERE `campaignID` = '".$newsRow['campaignID']."'";
        $updateNewsResult = $conn->query($updateNewsSQL);
    }
}