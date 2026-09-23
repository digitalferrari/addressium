<?php
/**
 * This script is designed to create and send breaking news email campaigns using AWS Pinpoint.
 * 
 * Configuration:
 * - The script loads global configuration settings from an ini file specified as a command-line argument.
 * - It sets up error reporting, memory limits, and the default timezone.
 * 
 * Functions:
 * - global_config($key): Manages global configuration settings.
 * - load_global_config($configLoc): Loads configuration settings from an ini file.
 * - getFrom(): Retrieves the 'From' email address from AWS Pinpoint.
 * - getNewsletter($emailTemplate, $segmentID, $pinTemplateName, $sendTime, $newsletterDisplayName, $preHeader, $storyTitle, $storyContent, $postURL, $postIMG): Generates the newsletter content.
 * - createCampaign($storyID, $storyTitle, $storyContent, $postURL, $postIMG, $sendTime, $segmentID, $emailTemplate, $pinTemplateName, $newsletterSubject, $newsletterDisplayName, $preHeader): Creates and sends an email campaign using AWS Pinpoint.
 * - cleanString($string): Cleans a string by removing special characters and replacing spaces with underscores.
 * 
 * Database:
 * - Connects to a MySQL database using credentials from the global configuration.
 * - Queries the database for various settings and content required to generate the newsletter.
 * 
 * AWS Pinpoint:
 * - Uses AWS SDK for PHP to interact with AWS Pinpoint.
 * - Creates email campaigns with specified content and schedules them for sending.
 * 
 * Execution:
 * - The script queries the database for posts tagged with 'sendbreakingemail' and published within the last 2 hours.
 * - For each qualifying post, it generates and sends a breaking news email campaign.
 * - If a campaign for the post has already been sent within the last 2 hours, it skips sending.
 * 
 * Dependencies:
 * - Requires the AWS SDK for PHP.
 * - Requires the Html2Text library for converting HTML to plain text.
 * 
 * Usage:
 * - Run the script from the command line, passing the path to the configuration ini file as an argument.
 */

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

function getFrom(){
    global $client;
    $result = $client->getEmailChannel([
        'ApplicationId' => global_config('pinAppID'), // REQUIRED
    ]);
    return $result['EmailChannelResponse']['FromAddress'];
}


/**
 * Summary of getNewsletter
 * @param mixed $newsletterID
 * @param mixed $emailTemplate
 * @param mixed $segmentID
 * @param mixed $pinTemplateName
 * @param mixed $sendTime
 * @param mixed $newsletterName
 * @return array|string|null
 */
function getNewsletter($emailTemplate,$segmentID,$pinTemplateName,$sendTime,$newsletterDisplayName,$preHeader,$storyTitle,$storyContent,$postURL,$postIMG){
  // echo "Get Newsletter $newsletterDisplayName\n";
    global $conn;

    $marqueeSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_ads WHERE tagType = 'Marquee' and newsletterID = 1000";
    $marqueeAdResult = $conn->query($marqueeSQL);
    $marqueeAdRows = $marqueeAdResult->fetch_all(MYSQLI_ASSOC);
    $footerSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_ads WHERE tagType = 'Footer' and newsletterID = 1000";
    $footerAdResult = $conn->query($footerSQL);
    $footerAdRows = $footerAdResult->fetch_all(MYSQLI_ASSOC);

    $optionSQL = "SELECT 
    GROUP_CONCAT(CASE WHEN option_name = 'image_fill' THEN option_value END) AS image_fill_value,
    GROUP_CONCAT(CASE WHEN option_name = 'mail_company_name' THEN option_value END) AS mail_company_name_value,
    GROUP_CONCAT(CASE WHEN option_name = 'mail_company_address' THEN option_value END) AS mail_company_address_value,
    GROUP_CONCAT(CASE WHEN option_name = 'mail_why' THEN option_value END) AS mail_why_value,
    GROUP_CONCAT(CASE WHEN option_name = 'mail_unsubscribe' THEN option_value END) AS mail_unsubscribe_value
FROM ".global_config('wpTablePrefix')."options 
WHERE option_name IN ('image_fill', 'mail_company_name', 'mail_company_address', 'mail_why', 'mail_unsubscribe')";
        $optionResult = $conn->query($optionSQL);
        $optionRow = $optionResult->fetch_assoc();
        $imageFill = $optionRow['image_fill_value'];
        if($postIMG == ''){
          $postIMG = $imageFill;
        }

        $mail_company_name = $optionRow['mail_company_name_value'];
        $mail_company_address = $optionRow['mail_company_address_value'];
        $mail_why = $optionRow['mail_why_value'];
        $mail_unsubscribe = $optionRow['mail_unsubscribe_value'];
        $currentYear = date('Y');

        $variableFind = array('*|CURRENT_YEAR|*','*|LIST:COMPANY|*','*|HTML:LIST_ADDRESS_HTML|* *|END:IF|*','*|IFNOT:ARCHIVE_PAGE|* *|LIST:DESCRIPTION|*','href=\"*|UNSUB|*');
        $variableReplace = array($currentYear,$mail_company_name,$mail_company_address,$mail_why,"ses:tags=\"unsubscribeLinkTag:click;\" href=\"".$mail_unsubscribe);
    

    $placementID = base64_encode(cleanString($newsletterDisplayName).$sendTime);
    $postURL = $postURL.'?utm_source=newsletter&utm_source_platform=pinpoint&utm_medium=email&utm_campaign='.cleanString($newsletterDisplayName).'&utm_id='.$placementID.'&utm_term='.date('Y-m-d', strtotime($sendTime));
    preg_match('/<p(?:\s+class="[^"]*")*>(.*?)<\/p>/s', $storyContent, $post);
    // print_r($post);
    $emailTemplate = str_replace($variableFind,$variableReplace,$emailTemplate);
    $emailTemplate = str_replace('{{URL}}', $postURL, str_replace('{{IMG}}', $postIMG, str_replace('{{BODYTEXT}}', strip_tags($post[1]), str_replace('{{HEADLINE}}', $storyTitle, $emailTemplate))));
    $emailTemplate = str_replace('{{MARQUEEAD}}', str_replace('{{MessageVersionInstance.Id}}',$placementID,str_replace('{LIST_ID}',$segmentID,$marqueeAdRows[0]['tagText'])), $emailTemplate);
    $emailTemplate = str_replace('{{SAFERTB}}', str_replace('{{MessageVersionInstance.Id}}',$placementID,str_replace('{LIST_ID}',$segmentID,$footerAdRows[0]['tagText'])), $emailTemplate);
    $emailTemplate = str_replace('{{NEWSLETTERNAME}}', $newsletterDisplayName, $emailTemplate);
    $emailTemplate = str_replace('{{PREHEADER}}', $preHeader, $emailTemplate);
    // return preg_replace('/<!-- START MAIN STORY -->(.*?)<!-- END BODY STORY -->/s', $newslStories, $emailTemplate);
    // return $emailTemplate;
    // $templatePrep = preg_replace('/<!-- START MAIN STORY -->(.*?)<!-- END BODY STORY -->/s', '{{CONTENT}}', stripslashes($emailTemplate), 1);
    return preg_replace('/[[:^print:]]/', '', $emailTemplate);
    
}



/**
 * Summary of createCampaign
 * @param mixed $subjectType
 * @param mixed $newsletterID
 * @param mixed $sendTime
 * @param mixed $segmentID
 * @param mixed $emailTemplate
 * @param mixed $pinTemplateName
 * @param mixed $newsletterSubject
 * @param mixed $firstHeadline
 * @param mixed $lastHeadline
 * @return void
 */
function createCampaign($storyID,$storyTitle,$storyContent,$postURL,$postIMG,$sendTime,$segmentID,$emailTemplate,$pinTemplateName,$newsletterSubject,$newsletterDisplayName,$preHeader){
    global $client;
    global $sdk;
    global $conn;
    // $sendTime = date('Y-m-d\TH:i:s\Z', strtotime($sendTime));
    // echo "Send Time:". $sendTime."\n";
    
  // echo "HERE!";
    $newsl_content = getNewsletter($emailTemplate,$segmentID,$pinTemplateName,$sendTime,$newsletterDisplayName,$preHeader,$storyTitle,$storyContent,$postURL,$postIMG);
    $campaignTitle = stripslashes($newsletterSubject);
    $subject = stripslashes($newsletterSubject);
    $frequency = 'ONCE';
  // echo stripslashes($newsl_content);

  $options = array(
    'ignore_errors' => true,
    // other options go here
  );
  echo "Create Date: ".date('c', strtotime($sendTime))."\n";
  $emailText = \Soundasleep\Html2Text::convert(stripslashes($newsl_content), $options);

echo "Segment ID: ".$segmentID."\n";

    $result = $client->createCampaign([
        'ApplicationId' => global_config('pinAppID'), // REQUIRED
        'WriteCampaignRequest' => [ // REQUIRED
          'Description' => substr('Campaign for '.$campaignTitle,0,95),
          'SegmentId' => $segmentID,
          'IsPaused' => false,
            'MessageConfiguration' => [
                'EmailMessage' => [
                  'Body' => $emailText,
                  'HtmlBody' => stripslashes($newsl_content),
                    'FromAddress' => getFrom(),
                    'Title' => 'Breaking News: '.$subject,
                ],
            ],
            'Name' => substr($campaignTitle,0,63),
            'Schedule' => [
                'IsLocalTime' => false,
                'StartTime' => date('c', strtotime($sendTime)),
                'Frequency' => $frequency,
            ]
        ],
    ]);   
    // print_r($result);

    $campaignID = $result['CampaignResponse']['Id'];
    $campaignStatus = $result['CampaignResponse']['State']['CampaignStatus'];
    // $campaignID = '7ed4c6ecab6743d9b2f9fddfb1cf27fe';
    // $campaignStatus = 'PENDING';
    if($campaignStatus != ''){
      $newsl_content = mysqli_real_escape_string($conn, $newsl_content);
      $subject = mysqli_real_escape_string($conn, $subject);
      // echo $insertSQL;
    // Execute the query
try {
  $insertSQL = "INSERT INTO ".global_config('wpTablePrefix')."aws_pinpoint_once_sends (subject, campaignName, sendTime, segmentID, segmentName, emailBody, fromEmail, campaignStatus, campaignID)
  VALUES ('{$subject}', '{$subject}', '{$sendTime}', '{$segmentID}', '', '{$newsl_content}', '{getFrom()}', 'PENDING', '{$campaignID}');";

  if ($conn->query($insertSQL)) {
        echo "Record inserted successfully.";
      } else {
          throw new Exception("Error: " . $conn->error);
      }
    } catch (Exception $e) {
      echo "Error: " . $e->getMessage();
    }
      }
    


}



/**
 * Summary of cleanString
 * @param mixed $string
 * @return array|string
 */
function cleanString($string) {
    // Remove special characters
    $string = preg_replace('/[^A-Za-z0-9\-]/', '', $string);
    
    // Replace spaces with underscores
    $string = str_replace(' ', '_', $string);
    
    return $string;
}


$segmentOptionSQL = "SELECT * FROM ".global_config('wpTablePrefix')."options WHERE option_name = 'breakingSegment'";
$segmentOptionResult = $conn->query($segmentOptionSQL);
$segmentOptionRow = $segmentOptionResult->fetch_assoc();
$breakingSegment = $segmentOptionRow['option_value'];

$optionSQL = "SELECT * FROM ".global_config('wpTablePrefix')."options WHERE option_name = 'image_fill'";
$optionResult = $conn->query($optionSQL);
$optionRow = $optionResult->fetch_assoc();
$imageFill = $optionRow['option_value'];



$templateSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_templates WHERE templateName = 'Breaking News'";
$templateResult = $conn->query($templateSQL);
$template = $templateResult->fetch_assoc();
$emailTemplate = $template['emailTemplate'];
$pinTemplateName = global_config('pinSiteCode')."_".cleanString('Breaking News');

date_default_timezone_set('America/Denver');


$breakingSQL = "SELECT
PO.id,
PO.post_title,
PO.post_content,
CONCAT('https://swiftmedia.s3.amazonaws.com/', SSS.path) AS pimg,
CONCAT(".global_config('wpTablePrefix')."options.option_value, '/', 'news', '/', PO.post_name) AS purl,
PO.post_date
FROM
".global_config('wpTablePrefix')."posts AS PO
INNER JOIN ".global_config('wpTablePrefix')."term_relationships AS TR ON TR.object_id = PO.id
INNER JOIN ".global_config('wpTablePrefix')."terms ON TR.term_taxonomy_id = ".global_config('wpTablePrefix')."terms.term_id
INNER JOIN ".global_config('wpTablePrefix')."options ON ".global_config('wpTablePrefix')."options.option_name = 'siteurl'
LEFT JOIN ".global_config('wpTablePrefix')."postmeta AS PM ON (PM.post_id = PO.id AND PM.meta_key = '_thumbnail_id')
LEFT JOIN ".global_config('wpTablePrefix')."as3cf_items AS SSS ON (SSS.source_id = PM.meta_value)
LEFT JOIN ".global_config('wpTablePrefix')."posts AS IPO ON (IPO.ID = PM.meta_value)
WHERE
PO.post_type = 'post'
AND PO.post_status = 'publish'
AND PO.ID IN (
    SELECT TR.object_id
    FROM ".global_config('wpTablePrefix')."term_relationships AS TR
    INNER JOIN ".global_config('wpTablePrefix')."terms ON TR.term_taxonomy_id = ".global_config('wpTablePrefix')."terms.term_id
    WHERE ".global_config('wpTablePrefix')."terms.slug = 'sendbreakingemail'
)
AND PO.post_date >= '".date('Y-m-d H:i:s', strtotime('-2 hour'))."'
GROUP BY
PO.id;";
// AND DATE_FORMAT(DATE_ADD(PO.post_date, INTERVAL 1 MINUTE), '%Y-%m-%d %H:%i') = DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i')";

echo $breakingSQL."\n\n";
$breakingResult = $conn->query($breakingSQL);

foreach($breakingResult as $breaking){
  $sqlTitle = mysqli_real_escape_string($conn, $breaking['post_title']);
  $checkSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_once_sends WHERE subject = '".$sqlTitle."' AND sendTime >= '".date('Y-m-d H:i:s', strtotime('-2 hour'))."'";
  $checkResult = $conn->query($checkSQL);
  if($checkResult->num_rows == 0){
    $breakingID = $breaking['id'];
    $breakingTitle = $breaking['post_title'];
    $breakingContent = $breaking['post_content'];
    $breakingSendTime = (new DateTime(date('Y-m-d H:i')))->modify('+2 minute')->format('Y-m-d H:i:s');
    echo "Breaking Send Time: ".$breakingSendTime."\n";
    $newsletterDisplayName = "BREAKING NEWS";
    $preHeader = "-"; //"Breaking News from ".global_config('pinSiteName');
    if($breaking['pimg'] == ''){
        $breaking['pimg'] = $imageFill;
      }
    // $breaking['purl'] = $breaking['purl'].'?utm_source=newsletter&utm_source_platform=pinpoint&utm_medium=email&utm_campaign='.cleanString($newsletterDisplayName).'&utm_id='.$placementID.'&utm_term='.date('Y-m-d', strtotime($sendTime));



    createCampaign($breakingID,$breakingTitle,$breakingContent,$breaking['purl'],$breaking['pimg'],$breakingSendTime,$breakingSegment,$emailTemplate,$pinTemplateName,$breakingTitle,$newsletterDisplayName,$preHeader);
    }else{
      echo "Already sent: ".$breaking['post_title']."\n";
    }
}

