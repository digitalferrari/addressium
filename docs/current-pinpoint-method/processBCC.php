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
$conn->query("SET NAMES 'utf8'");
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

/**
 * Summary of getFrom
 * @param mixed $fromEmail
 * @return string
 */
function getFrom($fromEmail){
  $addressSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_from_addresses WHERE id = ".$fromEmail;
  $addressResult = $GLOBALS['conn']->query($addressSQL)->fetch_object();
  $fromEmail = $addressResult->fromName." <".$addressResult->fromEmail.">";
  return $fromEmail;
}



function sendMessage($client, $appID, $subject, $message, $sendTime, $bccAddresses, $fromEmail, $id) {
  $fromEmail = getFrom($fromEmail);

    // Convert comma-separated email addresses to an array
    $addresses = array_map('trim',explode(',', $bccAddresses));

    // Send the campaign to the segment and the specified email addresses
    $addressesMap = [];
    foreach ($addresses as $address) {
    $addressesMap[$address] = ['ChannelType' => 'EMAIL'];
}

print_r($addressesMap);
    $result = $client->sendMessages([
        'ApplicationId' => global_config('pinAppID'),
        'MessageRequest' => [
            'Addresses' => $addressesMap,
            'MessageConfiguration' => [
                'EmailMessage' => [
                    'FromAddress' => $fromEmail,
                    'SimpleEmail' => [
                        'Subject' => [
                            'Charset' => 'UTF-8',
                            'Data' => stripslashes($subject),
                        ],
                        'HtmlPart' => [
                            'Charset' => 'UTF-8',
                            'Data' => stripslashes($message),
                        ],
                    ],
                ],
            ],
        ],
    ]);

$updateSQL = "UPDATE `".global_config('wpTablePrefix')."aws_pinpoint_once_sends` SET `bccSent` = 'true' WHERE `id` = ".$id;
$updateResult = $GLOBALS['conn']->query($updateSQL);

}



$oneTimeSendsSQL = "SELECT * FROM `".global_config('wpTablePrefix')."aws_pinpoint_once_sends` WHERE `sendTime` >= '".date('Y-m-d H:i:s', strtotime('-5 minutes'))."' and `sendTime` <= '".date('Y-m-d H:i:s')."' and (`bccAddresses` != '' or `bccAddresses` is not null) and (`bccSent` != 'true' or `bccSent` is null)";
echo $oneTimeSendsSQL."\n";
$oneTimeSendsResult = $conn->query($oneTimeSendsSQL);
while($otRow = $oneTimeSendsResult->fetch_assoc()) {
    
    sendMessage($client, global_config('pinAppID'), $otRow['subject'], $otRow['emailBody'], $otRow['sendTime'], $otRow['bccAddresses'], $otRow['fromEmail'], $otRow['id']);

    
}



