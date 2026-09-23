<?php

ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

ini_set("log_errors", 1);
ini_set("error_log", "/usr/web/swiftcron-scripts/logs/php-error.log");

ini_set('memory_limit','2048M');
date_default_timezone_set('America/Denver');

echo "Current Time: ".date('Y-m-d H:i:s')."\n";

$confFile = $argv[1];

// Extract the file name from the string
$confFileName = basename($confFile);

// Split the filename by "."
$confFileParts = explode(".", $confFileName);

// Check if the second part of the filename is "sd"
    $marketCode = substr($confFileParts[0],0,2);
    
    $lockFilename = "locks/processNews_".$marketCode."_lock.pid";
    
$lock_file = fopen($lockFilename, 'c');
$got_lock = flock($lock_file, LOCK_EX | LOCK_NB, $wouldblock);
if ($lock_file === false || (!$got_lock && !$wouldblock)) {
    throw new Exception(
        "Unexpected error opening or locking lock file. Perhaps you " .
        "don't  have permission to write to the lock file or its " .
        "containing directory?"
    );
}
else if (!$got_lock && $wouldblock) {
//     exit("Another instance is already running; terminating.\n");
exit;
}

// Lock acquired; let's write our PID to the lock file for the convenience
// of humans who may wish to terminate the script.
ftruncate($lock_file, 0);
fwrite($lock_file, getmypid() . "\n");


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
  // $configlocation = 'sdConfig.ini';
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
$conn->query("SET NAMES 'utf8mb4' COLLATE 'utf8mb4_general_ci';");


// require '/www/feeder.swiftcom.com/processors/AWS/vendor/autoload.php';
require '/usr/web/swiftcron-scripts/vendor/autoload.php';

use Aws\Pinpoint\PinpointClient;
use Aws\Credentials\Credentials;
use Aws\Exception\AwsException;
$awsKey = global_config('awsAccessKeyId');
$awsSecret = global_config('awsSecretAccessKey');
$awsRegion = global_config('awsRegion');
$credentials = new Credentials($awsKey, $awsSecret);



$client = new PinpointClient([
    'version' => 'latest',
    'region' => 'us-west-2',
    'credentials' => $credentials
]);

/**
 * Sanitizes email subject lines by decoding HTML entities and normalizing whitespace
 * This prevents issues like &amp; appearing in subjects instead of &
 *
 * @param string $text The text to sanitize
 * @return string The sanitized text
 */
function df_email_sanitize($text) {
    // Decode HTML entities (&amp; -> &, &quot; -> ", &#8217; -> ', etc.)
    $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');

    // Replace non-breaking spaces with regular spaces
    $text = str_replace("\u{00A0}", ' ', $text);
    $text = str_replace('&nbsp;', ' ', $text);

    // Normalize all whitespace (collapse multiple spaces, tabs, newlines into single space)
    $text = preg_replace('/\s+/', ' ', $text);

    // Trim leading/trailing whitespace
    return trim($text);
}

/**
 * Sanitizes HTML email body content to fix common WordPress encoding issues
 * Cleans up smart quotes, excessive &nbsp; entities, and non-breaking space characters
 * Preserves HTML structure while fixing text content issues
 *
 * @param string $html The HTML content to sanitize
 * @return string The sanitized HTML
 */
function df_email_content_sanitize($html) {
    // Replace smart quotes with straight quotes (WordPress often stores these)
    // Using Unicode escape sequences to avoid PHP parsing issues
    $html = str_replace(["\u{201C}", "\u{201D}"], '"', $html); // Left and right double curly quotes
    $html = str_replace(["\u{2018}", "\u{2019}"], "'", $html); // Left and right single curly quotes

    // Replace em dash and en dash with regular dash
    $html = str_replace(["\u{2014}", "\u{2013}"], '-', $html);

    // Replace ellipsis character with three periods
    $html = str_replace("\u{2026}", '...', $html);

    // Replace non-breaking space Unicode character with regular space
    $html = str_replace("\u{00A0}", ' ', $html);

    // Replace ALL &nbsp; HTML entities with regular spaces (including trailing ones)
    $html = str_replace('&nbsp;', ' ', $html);

    return $html;
}

function getFrom(){
  
    global $client;
    $result = $client->getEmailChannel([
        'ApplicationId' => global_config('pinAppID'), // REQUIRED
    ]);
    // print_r($result);
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
function getNewsletter($newsletterID,$emailTemplate,$segmentID,$pinTemplateName,$sendTime,$newsletterName,$category,$templateType,$newsletterDisplayName,$preHeader,$feedURL,$manualNewsletterID,$skipDate=false,$lastSendDate=null){
  // echo "Get Newsletter $newsletterID\n";
    global $conn;

    // If no lastSendDate provided, default to 1 day ago (original behavior)
    if($lastSendDate === null) {
        $lastSendDate = date('Y-m-d H:i:s', strtotime("- 1 days"));
        logMessage('WARN', 'getNewsletter() called without lastSendDate - defaulting to 1 day lookback');
    } else {
        logMessage('DEBUG', 'getNewsletter() using lookback period', [
            'lastSendDate' => $lastSendDate,
            'newsletterType' => $templateType
        ]);
    }

    if($templateType == 'Category' && isset($category)){
      // $sql = "SELECT DISTINCT ".global_config('wpTablePrefix')."posts.ID, CONCAT(".global_config('wpTablePrefix')."options.option_value, '/', ".global_config('wpTablePrefix')."terms.slug, '/', ".global_config('wpTablePrefix')."posts.post_name) AS post_url
      // FROM ".global_config('wpTablePrefix')."posts
      // INNER JOIN ".global_config('wpTablePrefix')."term_relationships ON ".global_config('wpTablePrefix')."posts.ID = ".global_config('wpTablePrefix')."term_relationships.object_id
      // INNER JOIN ".global_config('wpTablePrefix')."terms ON ".global_config('wpTablePrefix')."term_relationships.term_taxonomy_id = ".global_config('wpTablePrefix')."terms.term_id
      // INNER JOIN ".global_config('wpTablePrefix')."options ON ".global_config('wpTablePrefix')."options.option_name = 'siteurl'
      // WHERE ".global_config('wpTablePrefix')."terms.slug = '".$category."' AND ".global_config('wpTablePrefix')."posts.post_type = 'post' AND ".global_config('wpTablePrefix')."posts.post_status = 'publish' and ".global_config('wpTablePrefix')."posts.post_date > '".date('Y-m-d H:i:s', strtotime("- 1 days"))."' order by ".global_config('wpTablePrefix')."posts.post_date desc";
      // $result = $conn->query($sql);
      // $stories = array();
      // if ($result->num_rows > 0) {
      //     while($row = $result->fetch_assoc()) {
      //         $stories[] = $row['ID'];
      //     }
      //   }

      //   $storyList = implode(',',$stories);
        // echo $storyList.'\n';

        // $sql = "SELECT PO.id, PO.post_title, PO.post_content, IPO.guid AS pimg, PO.guid AS purl
        // FROM ".global_config('wpTablePrefix')."posts PO
        // LEFT JOIN ".global_config('wpTablePrefix')."postmeta PM ON (PM.post_id = PO.id AND PM.meta_key = '_thumbnail_id')
        // LEFT JOIN ".global_config('wpTablePrefix')."posts IPO ON (IPO.ID = PM.meta_value)
        // WHERE PO.id IN ($storyList)
        // ORDER BY PO.post_date DESC";

$sql = "SELECT DISTINCT ".global_config('wpTablePrefix')."posts.ID, ".global_config('wpTablePrefix')."posts.post_title, ".global_config('wpTablePrefix')."posts.post_content, CONCAT('https://swiftmedia.s3.amazonaws.com/', SSS.path) AS pimg, CONCAT(".global_config('wpTablePrefix')."options.option_value, '/', ".global_config('wpTablePrefix')."terms.slug, '/', ".global_config('wpTablePrefix')."posts.post_name, '/') AS purl
FROM ".global_config('wpTablePrefix')."posts
INNER JOIN ".global_config('wpTablePrefix')."term_relationships ON ".global_config('wpTablePrefix')."posts.ID = ".global_config('wpTablePrefix')."term_relationships.object_id
INNER JOIN ".global_config('wpTablePrefix')."terms ON ".global_config('wpTablePrefix')."term_relationships.term_taxonomy_id = ".global_config('wpTablePrefix')."terms.term_id
INNER JOIN ".global_config('wpTablePrefix')."options ON ".global_config('wpTablePrefix')."options.option_name = 'siteurl'
LEFT JOIN ".global_config('wpTablePrefix')."postmeta PM ON ".global_config('wpTablePrefix')."posts.ID = PM.post_id AND PM.meta_key = '_thumbnail_id'
LEFT JOIN ".global_config('wpTablePrefix')."as3cf_items SSS ON SSS.source_id = PM.meta_value
WHERE ".global_config('wpTablePrefix')."terms.slug = '".$category."'
  AND ".global_config('wpTablePrefix')."posts.post_type = 'post'
  AND ".global_config('wpTablePrefix')."posts.post_status = 'publish'
  AND ".global_config('wpTablePrefix')."posts.post_date > '".$lastSendDate."'
ORDER BY ".global_config('wpTablePrefix')."posts.post_date DESC";

      logMessage('DEBUG', 'Category content query built', [
          'category' => $category,
          'lookbackFrom' => $lastSendDate,
          'sqlLength' => strlen($sql) . ' chars'
      ]);


    }else if($templateType == 'Manual'){
      $sql = "SELECT * FROM ".global_config('wpTablePrefix')."postmeta WHERE post_id = $manualNewsletterID and meta_key like 'newsletter_stories_%' and meta_value != '' order by meta_key asc";
      echo $sql."\n";
      $result = $conn->query($sql);
      $stories = array();
      if ($result->num_rows > 0) {
          while($row = $result->fetch_assoc()) {
              $stories[] = $row['meta_value'];
          }  
        }
        $storyList = implode(',',$stories);
        echo $storyList.'\n';

    
        // $sql = "SELECT PO.id, PO.post_title, PO.post_content, IPO.guid AS pimg, PO.guid AS purl
        // FROM ".global_config('wpTablePrefix')."posts PO
        // LEFT JOIN ".global_config('wpTablePrefix')."postmeta PM ON (PM.post_id = PO.id AND PM.meta_key = '_thumbnail_id')
        // LEFT JOIN ".global_config('wpTablePrefix')."postmeta PM2 ON (PM2.meta_value = PO.id AND PM2.meta_key like 'newsletter_stories_%' AND PM2.meta_value != '')
        // LEFT JOIN ".global_config('wpTablePrefix')."posts IPO ON (IPO.ID = PM.meta_value)
        // WHERE PO.id IN ($storyList)
        // ORDER BY PM2.meta_key asc";

$sql = "SELECT PO.id, PO.post_title, PO.post_content, CONCAT('https://swiftmedia.s3.amazonaws.com/',SSS.path) AS pimg, CONCAT(".global_config('wpTablePrefix')."options.option_value, '/', ".global_config('wpTablePrefix')."terms.slug, '/', PO.post_name, '/') AS purl
FROM ".global_config('wpTablePrefix')."posts PO
LEFT JOIN ".global_config('wpTablePrefix')."postmeta PM ON (PM.post_id = PO.id AND PM.meta_key = '_thumbnail_id')
LEFT JOIN ".global_config('wpTablePrefix')."postmeta PM2 ON (PM2.meta_value = PO.id AND PM2.meta_key LIKE 'newsletter_stories_%' AND PM2.meta_value != '' and PM2.post_id = $manualNewsletterID)
LEFT JOIN ".global_config('wpTablePrefix')."as3cf_items SSS ON (SSS.source_id = PM.meta_value)
LEFT JOIN ".global_config('wpTablePrefix')."posts IPO ON (IPO.ID = PM.meta_value)
INNER JOIN (
    SELECT TR.object_id, MIN(".global_config('wpTablePrefix')."terms.term_id) AS min_term_id
    FROM ".global_config('wpTablePrefix')."term_relationships TR
    INNER JOIN ".global_config('wpTablePrefix')."terms ON TR.term_taxonomy_id = ".global_config('wpTablePrefix')."terms.term_id
    GROUP BY TR.object_id
) AS TR ON TR.object_id = PO.id
INNER JOIN ".global_config('wpTablePrefix')."terms ON TR.min_term_id = ".global_config('wpTablePrefix')."terms.term_id
INNER JOIN ".global_config('wpTablePrefix')."options ON ".global_config('wpTablePrefix')."options.option_name = 'siteurl'
WHERE PO.id IN ($storyList)
ORDER BY PM2.meta_key ASC";


        echo $sql."\n";
    
    
      }

    

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

        $newslStories = '';
        $storyCount = 0;        
        preg_match('/<!-- START MAIN STORY -->(.*?)<!-- END MAIN STORY -->/s', $emailTemplate, $matches);
        $main_story = $matches[1];
        preg_match('/<!-- START BODY STORY -->(.*?)<!-- END BODY STORY -->/s', $emailTemplate, $body_match);
        $body_story = $body_match[1];        
if(preg_match('/<!-- START NOIMAGE STORY -->(.*?)<!-- END NOIMAGE STORY -->/s', $emailTemplate, $body_noimage_match)){
          $body_noimage_story = $body_noimage_match[1];
        }
        
// echo $result->num_rows;
        $bodyAdSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_ads WHERE tagType = 'Body' and newsletterID = $newsletterID";
        $bodyAdResult = $conn->query($bodyAdSQL);
        $bodyAdCount = 0;
        $bodyAdNum = $bodyAdResult->num_rows;
        $adStories = array();
        $bodyAdRows = $bodyAdResult->fetch_all(MYSQLI_ASSOC);
        $marqueeSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_ads WHERE tagType = 'Marquee' and newsletterID = $newsletterID";
        // echo $marqueeSQL;
        $marqueeAdResult = $conn->query($marqueeSQL);
        $marqueeAdRows = $marqueeAdResult->fetch_all(MYSQLI_ASSOC);
        $footerSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_ads WHERE tagType = 'Footer' and newsletterID = $newsletterID";
        $footerAdResult = $conn->query($footerSQL);
        $footerAdRows = $footerAdResult->fetch_all(MYSQLI_ASSOC);
        $placementID = base64_encode(cleanString($newsletterDisplayName).$sendTime);
        $adWrapper = '<table class="row row-1" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tbody> <tr> <td> <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000; width: 600px; margin: 0 auto;" width="600"> <tbody> <tr> <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 5px; padding-top: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;"> <table class="divider_block block-3" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div class="alignment" align="center"> <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 1px solid #dddddd;"><span>&#8202;</span></td> </tr> </table> </div> </td> </tr> </table> <table class="paragraph_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;"> <tr> <td class="pad"> <div style="color:#101112;direction:ltr;font-family:Arial, Helvetica Neue, Helvetica, sans-serif;font-size:13px;font-weight:400;letter-spacing:0px;line-height:120%;text-align:left;mso-line-height-alt:15.6px;"> <p style="margin: 0;">Advertisement</p> </div> </td> </tr> </table> <table class="image_block block-2" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad" style="width:100%;"> <div class="alignment" align="center" style="line-height:10px"><p style="margin: 0;">{{ADPLACEMENT}}</p></div> </td> </tr> </table> <table class="divider_block block-3" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div class="alignment" align="center"> <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 1px solid #dddddd;"><span>&#8202;</span></td> </tr> </table> </div> </td> </tr> </table> </td> </tr> </tbody> </table> </td> </tr> </tbody> </table>';


        if(($templateType == 'Category' && isset($category)) || $templateType == 'Manual'){

          $result = $conn->query($sql);

        if ($result->num_rows > 0) {
            while($row = $result->fetch_assoc()) {
                            $row['purl'] = $row['purl'].'?utm_source=newsletter&utm_source_platform=pinpoint&utm_medium=email&utm_campaign='.cleanString($newsletterDisplayName).'&utm_id='.$placementID.'&utm_term='.date('Y-m-d', strtotime($sendTime));
                // print_r($row);
                preg_match('/<p(?:\s+class="[^"]*")*>(.*?)<\/p>/s', $row['post_content'], $post);
                if(empty($post[1])){
                  $post[1] = substr($row['post_content'],0,175).'...';
                }
                // $post[1] = 'Tester';
                
                $post[1] = preg_replace('/\n/', '  ', $post[1]); // **Step 1: Replace newline characters with double spaces**
                $post[1] = preg_replace('/[[:^print:]]/', '', $post[1]); // **Step 2: Remove non-printable characters**
                if($storyCount == 0){
                    $newslStories .= str_replace('{{URL}}', $row['purl'], str_replace('{{IMG}}', $row['pimg'], str_replace('{{BODYTEXT}}', strip_tags($post[1]), str_replace('{{HEADLINE}}', $row['post_title'], $main_story))));
                  }else{
if(empty($row['pimg']) && isset($body_noimage_story) && !empty($body_noimage_story)){
                      $newslStories .= str_replace('{{URL}}', $row['purl'], str_replace('{{BODYTEXT}}', strip_tags($post[1]), str_replace('{{HEADLINE}}', $row['post_title'], $body_noimage_story)));
                    }else{
                      if($row['pimg'] == ''){
                        $row['pimg'] = $imageFill;
                      }        
                    $newslStories .= str_replace('{{URL}}', $row['purl'], str_replace('{{IMG}}', $row['pimg'], str_replace('{{BODYTEXT}}', strip_tags($post[1]), str_replace('{{HEADLINE}}', $row['post_title'], $body_story))));
}
                    // echo $newslStories;
                }
                if($bodyAdCount < $bodyAdNum){
                    $adRow = str_replace('{{MessageVersionInstance.Id}}', $placementID, str_replace('{LIST_ID}', $segmentID, $bodyAdRows[$bodyAdCount]['tagText']));
                    $newslStories .= str_replace('{{ADPLACEMENT}}', $adRow, $adWrapper);
                }
                // $newslStories .= $row;
                $storyCount++;
                $bodyAdCount++;
            }
        }
      }else{
        
        $streamContext = stream_context_create(
          array(
              'http' => array(
                  'timeout' => 10,
              ),
              'ssl' => array(
                  'verify_peer' => false, // You could skip all of the trouble by changing this to false, but it's WAY uncool for security reasons.
              )
          )
      );
      
      $feedURLArray = explode(",", $feedURL);
      
      if (count($feedURLArray) > 1) {
          $firstFeedURL = trim($feedURLArray[0]);
          $firstFeed = file_get_contents($firstFeedURL, false, $streamContext);
          $combinedFeed = simplexml_load_string($firstFeed);
      
          for ($i = 1; $i < count($feedURLArray); $i++) {
              $newFeedURL = trim($feedURLArray[$i]);
              $feed = file_get_contents($newFeedURL, false, $streamContext);
              $xml = simplexml_load_string($feed);
      
              // Append items from the new feed to the combined feed
              foreach ($xml->channel->item as $item) {
                  $newItem = $combinedFeed->channel->addChild('item');
      
                  $newItem->addChild('title', (string)$item->title);
                  $newItem->addChild('link', (string)$item->link);
                  $newItem->addChild('pubDate', (string)$item->pubDate);
      
                  // Handle description using CDATA
                  $newDescription = $newItem->addChild('description');
                  $newDescriptionDom = dom_import_simplexml($newDescription);
      
                  $cdata = $newDescriptionDom->ownerDocument->createCDATASection((string)$item->description);
                  $newDescriptionDom->appendChild($cdata);
              }
          }
      
          $xml = $combinedFeed;
      } else {
          $feedURL = trim($feedURLArray[0]);
          $feed = file_get_contents($feedURL, false, $streamContext);
          $xml = simplexml_load_string($feed);
      }

      $xmlCount = count($xml->channel->item);


      if ($xmlCount > 0) {
        $storyCount = 0;
        foreach($xml->channel->item as $row) {
          if($storyCount >= '21'){
            break;
          }
          $row->title = preg_replace('/[[:^print:]]/', '', $row->title);
          $row->description = preg_replace('/[[:^print:]]/', '', $row->description);

          if(!isset($row->enclosure) || $row->enclosure == ''){
            $row->enclosure = $imageFill;
          }
          $row->link = $row->link.'?utm_source=newsletter&utm_source_platform=pinpoint&utm_medium=email&utm_campaign='.cleanString($newsletterDisplayName).'&utm_id='.$placementID.'&utm_term='.date('Y-m-d', strtotime($sendTime));
            if($storyCount == 0){
                $newslStories .= str_replace('{{URL}}', $row->link, str_replace('{{IMG}}', $row->enclosure, str_replace('{{BODYTEXT}}', strip_tags((string)$row->description), str_replace('{{HEADLINE}}', (string)$row->title, $main_story))));
}else{
                if(empty($row->enclosure) && isset($body_noimage_story) && !empty($body_noimage_story)){
                  $newslStories .= str_replace('{{URL}}', $row->link, str_replace('{{BODYTEXT}}', strip_tags((string)$row->description), str_replace('{{HEADLINE}}', (string)$row->title, $body_noimage_story)));
              }else{
                $newslStories .= str_replace('{{URL}}', $row->link, str_replace('{{IMG}}', $row->enclosure, str_replace('{{BODYTEXT}}', strip_tags((string)$row->description), str_replace('{{HEADLINE}}', (string)$row->title, $body_story))));
}
            }
            if($bodyAdCount < $bodyAdNum){
                $adRow = str_replace('{{MessageVersionInstance.Id}}', $placementID, str_replace('{LIST_ID}', $segmentID, $bodyAdRows[$bodyAdCount]['tagText']));
                $newslStories .= str_replace('{{ADPLACEMENT}}', $adRow, $adWrapper);
            }
            $storyCount++;
            $bodyAdCount++;
        }
    }

      }
    
	$mail_company_name = $optionRow['mail_company_name_value'];
	$mail_company_address = $optionRow['mail_company_address_value'];
	$mail_why = $optionRow['mail_why_value'];
	$mail_unsubscribe = $optionRow['mail_unsubscribe_value'];
	$currentYear = date('Y');
	
    $variableFind = array('*|CURRENT_YEAR|*','*|LIST:COMPANY|*','*|HTML:LIST_ADDRESS_HTML|* *|END:IF|*','*|IFNOT:ARCHIVE_PAGE|* *|LIST:DESCRIPTION|*','href=\"*|UNSUB|*');
    $variableReplace = array($currentYear,$mail_company_name,$mail_company_address,$mail_why,"ses:tags=\"unsubscribeLinkTag:click;\" href=\"".$mail_unsubscribe);
    $emailTemplate = str_replace($variableFind,$variableReplace,$emailTemplate);

    // Replace marquee ad if exists, otherwise remove placeholder
    if(isset($marqueeAdRows[0]) && isset($marqueeAdRows[0]['tagText'])) {
        $emailTemplate = str_replace('{{MARQUEEAD}}', str_replace('{{MessageVersionInstance.Id}}',$placementID,str_replace('{LIST_ID}',$segmentID,$marqueeAdRows[0]['tagText'])), $emailTemplate);
        logMessage('DEBUG', 'Marquee ad replaced in template');
    } else {
        $emailTemplate = str_replace('{{MARQUEEAD}}', '', $emailTemplate);
        logMessage('DEBUG', 'No marquee ad configured - placeholder removed');
    }

    // Replace footer ad if exists, otherwise remove placeholder
    if(isset($footerAdRows[0]) && isset($footerAdRows[0]['tagText'])) {
        $emailTemplate = str_replace('{{SAFERTB}}', str_replace('{{MessageVersionInstance.Id}}',$placementID,str_replace('{LIST_ID}',$segmentID,$footerAdRows[0]['tagText'])), $emailTemplate);
        logMessage('DEBUG', 'Footer ad replaced in template');
    } else {
        $emailTemplate = str_replace('{{SAFERTB}}', '', $emailTemplate);
        logMessage('DEBUG', 'No footer ad configured - placeholder removed');
    }

    $emailTemplate = str_replace('{{NEWSLETTERNAME}}', $newsletterDisplayName, $emailTemplate);
    $emailTemplate = str_replace('{{PREHEADER}}', $preHeader, $emailTemplate);

    // Process category story sections if they exist in template
    if(preg_match('/<!-- START CATEGORY STORIES -->(.*?)<!-- END CATEGORY STORIES -->/s', $emailTemplate)) {
        logMessage('DEBUG', 'Template contains category story sections - checking for custom fields');

        // Check if this is a manual newsletter with category story fields
        if($templateType == 'Manual' && !empty($manualNewsletterID)) {
            // Query for the custom category fields
            $categoryFieldsSQL = "SELECT
                meta1.meta_value as aftermainone_cat,
                meta2.meta_value as aftermaintwo_cat
                FROM ".global_config('wpTablePrefix')."posts p
                LEFT JOIN ".global_config('wpTablePrefix')."postmeta meta1 ON p.ID = meta1.post_id AND meta1.meta_key = 'newsletter_aftermainone_stories'
                LEFT JOIN ".global_config('wpTablePrefix')."postmeta meta2 ON p.ID = meta2.post_id AND meta2.meta_key = 'newsletter_aftermaintwo_stories'
                WHERE p.ID = $manualNewsletterID";

            logMessage('DEBUG', 'Querying for category fields', [
                'manualNewsletterID' => $manualNewsletterID,
                'sql' => $categoryFieldsSQL
            ]);

            $categoryFieldsResult = $conn->query($categoryFieldsSQL);

            if($categoryFieldsResult && $categoryFieldsResult->num_rows > 0) {
                $categoryFields = $categoryFieldsResult->fetch_assoc();
                $categoryOneCat = $categoryFields['aftermainone_cat'];
                $categoryTwoCat = $categoryFields['aftermaintwo_cat'];

                logMessage('INFO', 'Category fields found in database', [
                    'categoryOne' => $categoryOneCat ?: '(empty)',
                    'categoryTwo' => $categoryTwoCat ?: '(empty)',
                    'note' => 'These are the category slugs from WordPress custom fields'
                ]);

                // Extract template sections
                preg_match('/<!-- BEGIN NEWSLETTER_AFTERMAINONE_STORIES -->(.*?)<!-- END NEWSLETTER_AFTERMAINONE_STORIES -->/s', $emailTemplate, $catOneMatches);
                $catOneTemplate = $catOneMatches[1] ?? '';

                preg_match('/<!-- BEGIN NEWSLETTER_AFTERMAINTWO_STORIES -->(.*?)<!-- END NEWSLETTER_AFTERMAINTWO_STORIES -->/s', $emailTemplate, $catTwoMatches);
                $catTwoTemplate = $catTwoMatches[1] ?? '';

                $catOneStories = '';
                $catTwoStories = '';
                $catOneNiceName = '';
                $catTwoNiceName = '';

                // Process Category One stories
                if(!empty($categoryOneCat) && !empty($catOneTemplate)) {
                    // Check if this is a term_id (numeric) or slug (string)
                    $catOneIsNumeric = is_numeric($categoryOneCat);

                    logMessage('INFO', 'Processing category one stories', [
                        'categoryValue' => $categoryOneCat,
                        'isTermID' => $catOneIsNumeric ? 'yes' : 'no',
                        'lookbackDate' => $lastSendDate
                    ]);

                    // Get category nice name - handle both term_id and slug
                    if($catOneIsNumeric) {
                        $catOneNameSQL = "SELECT name, slug FROM ".global_config('wpTablePrefix')."terms WHERE term_id = ".(int)$categoryOneCat;
                    } else {
                        $catOneNameSQL = "SELECT name, slug FROM ".global_config('wpTablePrefix')."terms WHERE slug = '".$conn->real_escape_string($categoryOneCat)."'";
                    }

                    $catOneNameResult = $conn->query($catOneNameSQL);
                    $catOneSlug = $categoryOneCat; // Default to original value

                    if($catOneNameResult && $catOneNameResult->num_rows > 0) {
                        $catOneRow = $catOneNameResult->fetch_assoc();
                        $catOneNiceName = $catOneRow['name'];
                        $catOneSlug = $catOneRow['slug'];
                        logMessage('DEBUG', 'Category one found', [
                            'niceName' => $catOneNiceName,
                            'slug' => $catOneSlug,
                            'termID' => $catOneIsNumeric ? $categoryOneCat : 'N/A'
                        ]);
                    } else {
                        logMessage('WARN', 'Category one not found in terms table', [
                            'value' => $categoryOneCat,
                            'searchedBy' => $catOneIsNumeric ? 'term_id' : 'slug'
                        ]);
                    }

                    // Query posts from category one with featured images
                    // Use term_id if numeric, otherwise use slug
                    if($catOneIsNumeric) {
                        $catOnePostsSQL = "SELECT p.ID, p.post_title, p.post_excerpt, p.post_content, p.guid, p.post_date,
                            pm.meta_value as thumbnail_id,
                            s3.path as s3_path
                            FROM ".global_config('wpTablePrefix')."posts p
                            INNER JOIN ".global_config('wpTablePrefix')."term_relationships tr ON p.ID = tr.object_id
                            INNER JOIN ".global_config('wpTablePrefix')."terms t ON tr.term_taxonomy_id = t.term_id
                            LEFT JOIN ".global_config('wpTablePrefix')."postmeta pm ON p.ID = pm.post_id AND pm.meta_key = '_thumbnail_id'
                            LEFT JOIN ".global_config('wpTablePrefix')."as3cf_items s3 ON pm.meta_value = s3.source_id AND s3.source_type = 'media-library'
                            WHERE t.term_id = ".(int)$categoryOneCat."
                            AND p.post_status = 'publish'
                            AND p.post_type = 'post'
                            AND p.post_date > '".$lastSendDate."'
                            ORDER BY p.post_date DESC
                            LIMIT 3";
                    } else {
                        $catOnePostsSQL = "SELECT p.ID, p.post_title, p.post_excerpt, p.post_content, p.guid, p.post_date,
                            pm.meta_value as thumbnail_id,
                            s3.path as s3_path
                            FROM ".global_config('wpTablePrefix')."posts p
                            INNER JOIN ".global_config('wpTablePrefix')."term_relationships tr ON p.ID = tr.object_id
                            INNER JOIN ".global_config('wpTablePrefix')."terms t ON tr.term_taxonomy_id = t.term_id
                            LEFT JOIN ".global_config('wpTablePrefix')."postmeta pm ON p.ID = pm.post_id AND pm.meta_key = '_thumbnail_id'
                            LEFT JOIN ".global_config('wpTablePrefix')."as3cf_items s3 ON pm.meta_value = s3.source_id AND s3.source_type = 'media-library'
                            WHERE t.slug = '".$conn->real_escape_string($categoryOneCat)."'
                            AND p.post_status = 'publish'
                            AND p.post_type = 'post'
                            AND p.post_date > '".$lastSendDate."'
                            ORDER BY p.post_date DESC
                            LIMIT 3";
                    }

                    logMessage('DEBUG', 'Executing category one post query', [
                        'sql' => substr($catOnePostsSQL, 0, 500) . '...',
                        'categorySlug' => $categoryOneCat,
                        'lookbackDate' => $lastSendDate,
                        'limit' => 3
                    ]);

                    $catOnePostsResult = $conn->query($catOnePostsSQL);
                    $catOnePostCount = $catOnePostsResult ? $catOnePostsResult->num_rows : 0;

                    logMessage('INFO', 'Category one query executed', [
                        'postsFound' => $catOnePostCount,
                        'categorySlug' => $categoryOneCat
                    ]);

                    if($catOnePostsResult && $catOnePostCount > 0) {
                        while($post = $catOnePostsResult->fetch_assoc()) {
                            $postURL = $post['guid'] . '?utm_source=newsletter&utm_source_platform=pinpoint&utm_medium=email&utm_campaign='.cleanString($newsletterDisplayName).'&utm_id='.$placementID.'&utm_term='.date('Y-m-d', strtotime($sendTime));
                            $postTitle = preg_replace('/[[:^print:]]/', '', $post['post_title']);
                            $postExcerpt = !empty($post['post_excerpt']) ? strip_tags($post['post_excerpt']) : strip_tags(substr($post['post_content'], 0, 150));
                            $postExcerpt = preg_replace('/[[:^print:]]/', '', $postExcerpt);

                            // Get featured image from S3 or use fill image
                            $postImage = !empty($post['s3_path']) ? 'https://swiftmedia.s3.amazonaws.com/' . $post['s3_path'] : $imageFill;

                            logMessage('DEBUG', 'Adding category one post', [
                                'postID' => $post['ID'],
                                'postTitle' => substr($postTitle, 0, 80),
                                'hasImage' => !empty($post['s3_path']) ? 'yes' : 'no',
                                'postDate' => $post['post_date'] ?? 'unknown'
                            ]);

                            $storyHTML = str_replace('{{URL}}', $postURL, $catOneTemplate);
                            $storyHTML = str_replace('{{HEADLINE}}', $postTitle, $storyHTML);
                            $storyHTML = str_replace('{{BODYTEXT}}', $postExcerpt, $storyHTML);
                            $storyHTML = str_replace('{{IMG}}', $postImage, $storyHTML);

                            $catOneStories .= $storyHTML;
                        }
                        logMessage('DEBUG', 'Category one stories built', ['count' => $catOnePostsResult->num_rows]);
                    }
                }

                // Process Category Two stories
                if(!empty($categoryTwoCat) && !empty($catTwoTemplate)) {
                    // Check if this is a term_id (numeric) or slug (string)
                    $catTwoIsNumeric = is_numeric($categoryTwoCat);

                    logMessage('INFO', 'Processing category two stories', [
                        'categoryValue' => $categoryTwoCat,
                        'isTermID' => $catTwoIsNumeric ? 'yes' : 'no',
                        'lookbackDate' => $lastSendDate
                    ]);

                    // Get category nice name - handle both term_id and slug
                    if($catTwoIsNumeric) {
                        $catTwoNameSQL = "SELECT name, slug FROM ".global_config('wpTablePrefix')."terms WHERE term_id = ".(int)$categoryTwoCat;
                    } else {
                        $catTwoNameSQL = "SELECT name, slug FROM ".global_config('wpTablePrefix')."terms WHERE slug = '".$conn->real_escape_string($categoryTwoCat)."'";
                    }

                    $catTwoNameResult = $conn->query($catTwoNameSQL);
                    $catTwoSlug = $categoryTwoCat; // Default to original value

                    if($catTwoNameResult && $catTwoNameResult->num_rows > 0) {
                        $catTwoRow = $catTwoNameResult->fetch_assoc();
                        $catTwoNiceName = $catTwoRow['name'];
                        $catTwoSlug = $catTwoRow['slug'];
                        logMessage('DEBUG', 'Category two found', [
                            'niceName' => $catTwoNiceName,
                            'slug' => $catTwoSlug,
                            'termID' => $catTwoIsNumeric ? $categoryTwoCat : 'N/A'
                        ]);
                    } else {
                        logMessage('WARN', 'Category two not found in terms table', [
                            'value' => $categoryTwoCat,
                            'searchedBy' => $catTwoIsNumeric ? 'term_id' : 'slug'
                        ]);
                    }

                    // Query posts from category two with featured images
                    // Use term_id if numeric, otherwise use slug
                    if($catTwoIsNumeric) {
                        $catTwoPostsSQL = "SELECT p.ID, p.post_title, p.post_excerpt, p.post_content, p.guid, p.post_date,
                            pm.meta_value as thumbnail_id,
                            s3.path as s3_path
                            FROM ".global_config('wpTablePrefix')."posts p
                            INNER JOIN ".global_config('wpTablePrefix')."term_relationships tr ON p.ID = tr.object_id
                            INNER JOIN ".global_config('wpTablePrefix')."terms t ON tr.term_taxonomy_id = t.term_id
                            LEFT JOIN ".global_config('wpTablePrefix')."postmeta pm ON p.ID = pm.post_id AND pm.meta_key = '_thumbnail_id'
                            LEFT JOIN ".global_config('wpTablePrefix')."as3cf_items s3 ON pm.meta_value = s3.source_id AND s3.source_type = 'media-library'
                            WHERE t.term_id = ".(int)$categoryTwoCat."
                            AND p.post_status = 'publish'
                            AND p.post_type = 'post'
                            AND p.post_date > '".$lastSendDate."'
                            ORDER BY p.post_date DESC
                            LIMIT 2";
                    } else {
                        $catTwoPostsSQL = "SELECT p.ID, p.post_title, p.post_excerpt, p.post_content, p.guid, p.post_date,
                            pm.meta_value as thumbnail_id,
                            s3.path as s3_path
                            FROM ".global_config('wpTablePrefix')."posts p
                            INNER JOIN ".global_config('wpTablePrefix')."term_relationships tr ON p.ID = tr.object_id
                            INNER JOIN ".global_config('wpTablePrefix')."terms t ON tr.term_taxonomy_id = t.term_id
                            LEFT JOIN ".global_config('wpTablePrefix')."postmeta pm ON p.ID = pm.post_id AND pm.meta_key = '_thumbnail_id'
                            LEFT JOIN ".global_config('wpTablePrefix')."as3cf_items s3 ON pm.meta_value = s3.source_id AND s3.source_type = 'media-library'
                            WHERE t.slug = '".$conn->real_escape_string($categoryTwoCat)."'
                            AND p.post_status = 'publish'
                            AND p.post_type = 'post'
                            AND p.post_date > '".$lastSendDate."'
                            ORDER BY p.post_date DESC
                            LIMIT 2";
                    }

                    logMessage('DEBUG', 'Executing category two post query', [
                        'sql' => substr($catTwoPostsSQL, 0, 500) . '...',
                        'categorySlug' => $categoryTwoCat,
                        'lookbackDate' => $lastSendDate,
                        'limit' => 2
                    ]);

                    $catTwoPostsResult = $conn->query($catTwoPostsSQL);
                    $catTwoPostCount = $catTwoPostsResult ? $catTwoPostsResult->num_rows : 0;

                    logMessage('INFO', 'Category two query executed', [
                        'postsFound' => $catTwoPostCount,
                        'categorySlug' => $categoryTwoCat
                    ]);

                    if($catTwoPostsResult && $catTwoPostCount > 0) {
                        while($post = $catTwoPostsResult->fetch_assoc()) {
                            $postURL = $post['guid'] . '?utm_source=newsletter&utm_source_platform=pinpoint&utm_medium=email&utm_campaign='.cleanString($newsletterDisplayName).'&utm_id='.$placementID.'&utm_term='.date('Y-m-d', strtotime($sendTime));
                            $postTitle = preg_replace('/[[:^print:]]/', '', $post['post_title']);
                            $postExcerpt = !empty($post['post_excerpt']) ? strip_tags($post['post_excerpt']) : strip_tags(substr($post['post_content'], 0, 150));
                            $postExcerpt = preg_replace('/[[:^print:]]/', '', $postExcerpt);

                            // Get featured image from S3 or use fill image
                            $postImage = !empty($post['s3_path']) ? 'https://swiftmedia.s3.amazonaws.com/' . $post['s3_path'] : $imageFill;

                            logMessage('DEBUG', 'Adding category two post', [
                                'postID' => $post['ID'],
                                'postTitle' => substr($postTitle, 0, 80),
                                'hasImage' => !empty($post['s3_path']) ? 'yes' : 'no',
                                'postDate' => $post['post_date'] ?? 'unknown'
                            ]);

                            $storyHTML = str_replace('{{URL}}', $postURL, $catTwoTemplate);
                            $storyHTML = str_replace('{{HEADLINE}}', $postTitle, $storyHTML);
                            $storyHTML = str_replace('{{BODYTEXT}}', $postExcerpt, $storyHTML);
                            $storyHTML = str_replace('{{IMG}}', $postImage, $storyHTML);

                            $catTwoStories .= $storyHTML;
                        }
                        logMessage('DEBUG', 'Category two stories built', ['count' => $catTwoPostsResult->num_rows]);
                    }
                }

                // Replace category names and stories in template
                logMessage('INFO', 'Replacing category names in template', [
                    'categoryOneNiceName' => $catOneNiceName ?: '(empty)',
                    'categoryTwoNiceName' => $catTwoNiceName ?: '(empty)',
                    'categoryOneStoryCount' => substr_count($catOneStories, '<!-- story -->'),
                    'categoryTwoStoryCount' => substr_count($catTwoStories, '<!-- story -->')
                ]);

                $emailTemplate = str_replace('{{CATEGORYONENICENAME}}', $catOneNiceName, $emailTemplate);
                $emailTemplate = str_replace('{{CATEGORYTWONICENAME}}', $catTwoNiceName, $emailTemplate);

                // Replace the repeated sections with the built HTML
                if(!empty($catOneStories)) {
                    $emailTemplate = preg_replace('/<!-- BEGIN NEWSLETTER_AFTERMAINONE_STORIES -->(.*?)<!-- END NEWSLETTER_AFTERMAINONE_STORIES -->/s', $catOneStories, $emailTemplate);
                } else {
                    // Remove the section if no stories
                    $emailTemplate = preg_replace('/<!-- BEGIN NEWSLETTER_AFTERMAINONE_STORIES -->(.*?)<!-- END NEWSLETTER_AFTERMAINONE_STORIES -->/s', '', $emailTemplate);
                }

                if(!empty($catTwoStories)) {
                    $emailTemplate = preg_replace('/<!-- BEGIN NEWSLETTER_AFTERMAINTWO_STORIES -->(.*?)<!-- END NEWSLETTER_AFTERMAINTWO_STORIES -->/s', $catTwoStories, $emailTemplate);
                } else {
                    // Remove the section if no stories
                    $emailTemplate = preg_replace('/<!-- BEGIN NEWSLETTER_AFTERMAINTWO_STORIES -->(.*?)<!-- END NEWSLETTER_AFTERMAINTWO_STORIES -->/s', '', $emailTemplate);
                }

                // If both categories are empty, remove entire category stories section
                if(empty($catOneStories) && empty($catTwoStories)) {
                    $emailTemplate = preg_replace('/<!-- START CATEGORY STORIES -->(.*?)<!-- END CATEGORY STORIES -->/s', '', $emailTemplate);
                    logMessage('DEBUG', 'No category stories - removed entire section');
                }

            } else {
                // No category fields found - remove the entire section
                $emailTemplate = preg_replace('/<!-- START CATEGORY STORIES -->(.*?)<!-- END CATEGORY STORIES -->/s', '', $emailTemplate);
                logMessage('DEBUG', 'No category fields in database - removed category section');
            }
        } else {
            // Not a manual newsletter or template doesn't have the section - remove it
            $emailTemplate = preg_replace('/<!-- START CATEGORY STORIES -->(.*?)<!-- END CATEGORY STORIES -->/s', '', $emailTemplate);
            logMessage('DEBUG', 'Not a manual newsletter - removed category section');
        }
    }

if(isset($body_noimage_story) && !empty($body_noimage_story)){
      $templatePrep = preg_replace('/<!-- START MAIN STORY -->(.*?)<!-- END NOIMAGE STORY -->/s', '{{CONTENT}}', stripslashes($emailTemplate), 1);
    }else{
    $templatePrep = preg_replace('/<!-- START MAIN STORY -->(.*?)<!-- END BODY STORY -->/s', '{{CONTENT}}', stripslashes($emailTemplate), 1);
}
    // echo str_replace('{{CONTENT}}', $newslStories, $templatePrep);
    // return preg_replace('/[^[:print:]“”‘’’]/u', '', str_replace('{{CONTENT}}', $newslStories, $templatePrep));
    return str_replace('{{CONTENT}}', $newslStories, $templatePrep);
    
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
function createCampaign($id,$subjectType,$newsletterID,$newsletterName,$sendTime,$segmentID,$emailTemplate,$pinTemplateName,$newsletterSubject,$firstHeadline,$lastHeadline,$frequency,$endOn,$endDate,$segmentName,$templateName,$category,$templateType,$newsletterDisplayName,$preHeader,$feedURL,$customSubject,$manualNewsletterID,$skipDate=false,$lastSendDate=null){
  global $conn;
  global $client;

  echo "Creating Campaign: ".stripslashes($newsletterDisplayName)."\n\n";

  logMessage('INFO', '--- createCampaign() START ---', [
      'newsletterDisplayName' => $newsletterDisplayName,
      'skipDate' => $skipDate,
      'segmentID' => substr($segmentID, 0, 8) . '...',
      'segmentName' => $segmentName,
      'sendTime' => $sendTime,
      'frequency' => $frequency,
      'lastSendDate' => $lastSendDate
  ]);


// echo "SegmentID: ".$segmentID."\n";
  // echo "HERE!";
  if($skipDate){
    // Provide minimal HTML content for paused campaigns (AWS Pinpoint requires Body/HtmlBody)
    // This will never be sent (campaign is paused + Nobody segment), but API needs valid content
    $newsl_content = "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>Newsletter Paused</title></head><body><p>This newsletter has been paused due to no new content available.</p></body></html>";

    logMessage('DEBUG', 'Using placeholder content for paused campaign', [
        'note' => 'Campaign is paused and uses Nobody segment - this content will not be sent'
    ]);
  }else{
    $newsl_content = getNewsletter($newsletterID,$emailTemplate,$segmentID,$pinTemplateName,$sendTime,$newsletterName,$category,$templateType,$newsletterDisplayName,$preHeader,$feedURL,$manualNewsletterID,false,$lastSendDate);

    // Sanitize email content to fix smart quotes, &nbsp; issues, etc.
    $newsl_content = df_email_content_sanitize($newsl_content);

    logMessage('DEBUG', 'Email content sanitized', [
        'note' => 'Cleaned smart quotes, excess &nbsp;, and special characters'
    ]);
  }
  $campaignTitle = stripslashes($newsletterDisplayName);
  echo "Campaign Title: ".stripslashes($campaignTitle)."\n";
  if($subjectType == 'Newsletter'){
    $subject = $newsletterSubject;
  }else if($subjectType == 'First Headline'){
    $subject = $firstHeadline;
  }else if($subjectType == 'Last Headline'){
    $subject = $lastHeadline;
  }else if($subjectType == 'Custom'){
    $subject = $customSubject;
  }

  // Log subject before and after sanitization
  $subjectBefore = stripslashes($subject);
  $subjectAfter = df_email_sanitize($subjectBefore);
  if($subjectBefore !== $subjectAfter) {
      logMessage('DEBUG', 'Subject sanitized - HTML entities/whitespace cleaned', [
          'before' => substr($subjectBefore, 0, 100),
          'after' => substr($subjectAfter, 0, 100),
          'subjectType' => $subjectType
      ]);
  }

  // echo "Segment ID: ".$segmentID."\n";
    // echo stripslashes($newsl_content);
    // exit;

// $newsl_content = '<!DOCTYPE html> <html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en"> <head> <title></title> <meta http-equiv="Content-Type" content="text/html; charset=utf-8"> <meta name="viewport" content="width=device-width, initial-scale=1.0"><!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--> <style> * { box-sizing: border-box; } body { margin: 0; padding: 0; } a[x-apple-data-detectors] { color: inherit !important; text-decoration: inherit !important; } #MessageViewBody a { color: inherit; text-decoration: none; } p { line-height: inherit } .desktop_hide, .desktop_hide table { mso-hide: all; display: none; max-height: 0px; overflow: hidden; } .image_block img+div { display: none; } @media (max-width:765px) { .image_block img.big, .row-content { width: 100% !important; } .mobile_hide { display: none; } .stack .column { width: 100%; display: block; } .mobile_hide { min-height: 0; max-height: 0; max-width: 0; overflow: hidden; font-size: 0px; } .desktop_hide, .desktop_hide table { display: table !important; max-height: none !important; } } </style> </head> <body style="background-color: #FFFFFF; margin: 0; padding: 0; -webkit-text-size-adjust: none; text-size-adjust: none;"><div class="preheader" style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">Welcome to your daily dose of Summit.</div> <table class="nl-container" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #FFFFFF;"> <tbody> <tr> <td> <table class="row row-1" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tbody> <tr> <td> <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000000; width: 745px;" width="745"> <tbody> <tr> <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 5px; padding-top: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;"> <table class="html_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div style="font-family:Arial, \'Helvetica Neue\', Helvetica, sans-serif;text-align:center;" align="center"><div class="our-class"><table border="0" cellpadding="0" cellspacing="0" style="margin-left: auto; margin-right: auto;"><tr><td colspan="2"><a href="https://sli.summitdaily.com/click?s=792903&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=default" rel="nofollow"><img src="https://sli.summitdaily.com/imp?s=792903&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=default" border="0" width="740" style="width: 100%; max-width: 740px !important;"/></a></td></tr><tr><td align="left"><a style="display: block; max-width: 116px;  max-height: 15px;" href="https://sli.summitdaily.com/click?s=792904&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=static" rel="nofollow"><img src="https://sli.summitdaily.com/imp?s=792904&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=static" border="0"/></a></td><td align="right"><a style="display: block; max-width: 19px;  max-height: 15px;" href="https://sli.summitdaily.com/click?s=792906&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=static" rel="nofollow"><img src="https://sli.summitdaily.com/imp?s=792906&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=static" border="0"/></a></td></tr></table></div></div> </td> </tr> </table> <table class="divider_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div class="alignment" align="center"> <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 1px solid #dddddd;"><span>&#8202;</span></td> </tr> </table> </div> </td> </tr> </table> <table class="image_block block-3" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad" style="width:100%;padding-right:0px;padding-left:0px;"> <div class="alignment" align="center" style="line-height:10px"><img class="big" src="https://d15k2d11r6t6rl.cloudfront.net/public/users/Integrators/BeeProAgency/709479_692256/1776120.jpeg" style="display: block; height: auto; border: 0; width: 650px; max-width: 100%;" width="650"></div> </td> </tr> </table> <table class="heading_block block-4" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <h1 style="margin: 0; color: #000000; direction: ltr; font-family: Arial, \'Helvetica Neue\', Helvetica, sans-serif; font-size: 20px; font-weight: 700; letter-spacing: normal; line-height: 120%; text-align: center; margin-top: 0; margin-bottom: 0;"><span class="tinyMce-placeholder">Local News Flash</span></h1> </td> </tr> </table> <table class="divider_block block-5" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div class="alignment" align="center"> <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 1px solid #dddddd;"><span>&#8202;</span></td> </tr> </table> </div> </td> </tr> </table> </td> </tr> </tbody> </table> </td> </tr> </tbody> </table> <table class="row row-2" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tbody> <tr> <td> <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000000; width: 745px;" width="745"> <tbody> <tr> <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 5px; padding-top: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;"> <table class="image_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad" style="width:100%;padding-right:0px;padding-left:0px;"> <div class="alignment" align="center" style="line-height:10px"><img class="big" src="https://www.summitdaily.com/wp-content/uploads/sites/2/2019/06/SD_logo_website-1.jpg" style="display: block; height: auto; border: 0; width: 500px; max-width: 100%;" width="500"></div> </td> </tr> </table> <table class="text_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;"> <tr> <td class="pad"> <div style="font-family: sans-serif"> <div class style="font-size: 12px; font-family: Arial, \'Helvetica Neue\', Helvetica, sans-serif; mso-line-height-alt: 14.399999999999999px; color: #555555; line-height: 1.2;"> <p style="margin: 0; font-size: 16px; text-align: left; mso-line-height-alt: 19.2px;"><span style="font-size:20px;"><strong>Fresh approach pays off on the ice for Sailors hockey</strong></span></p> </div> </div> </td> </tr> </table> <table class="divider_block block-3" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div class="alignment" align="center"> <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 1px solid #BBBBBB;"><span>&#8202;</span></td> </tr> </table> </div> </td> </tr> </table> <table class="text_block block-4" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;"> <tr> <td class="pad"> <div style="font-family: sans-serif"> <div class style="font-size: 12px; font-family: Arial, \'Helvetica Neue\', Helvetica, sans-serif; mso-line-height-alt: 14.399999999999999px; color: #555555; line-height: 1.2;"> <p style="margin: 0; font-size: 14px; text-align: left; mso-line-height-alt: 16.8px;">STEAMBOAT SPRINGS ? Coach Yancey Rushton would love to watch the Steamboat Springs High School varsity hockey team skate to a winning record for the first time in several seasons, but for him, success isn\'t measured in wins.</p> </div> </div> </td> </tr> </table> <table class="button_block block-5" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div class="alignment" align="right"><!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="https://dev.summitdaily.com/?p=435129?utm_source=newsletter&utm_source_platform=pinpoint&utm_medium=email&utm_campaign=LocalNewsFlash&utm_id=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&utm_term=2023-06-02" style="height:42px;width:119px;v-text-anchor:middle;" arcsize="10%" stroke="false" fillcolor="#037bc1"><w:anchorlock/><v:textbox inset="0px,0px,0px,0px"><center style="color:#ffffff; font-family:Arial, sans-serif; font-size:16px"><![endif]--><a href="https://dev.summitdaily.com/?p=435129?utm_source=newsletter&utm_source_platform=pinpoint&utm_medium=email&utm_campaign=LocalNewsFlash&utm_id=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&utm_term=2023-06-02" target="_blank" style="text-decoration:none;display:inline-block;color:#ffffff;background-color:#037bc1;border-radius:4px;width:auto;border-top:0px solid transparent;font-weight:undefined;border-right:0px solid transparent;border-bottom:0px solid transparent;border-left:0px solid transparent;padding-top:5px;padding-bottom:5px;font-family:Arial, \'Helvetica Neue\', Helvetica, sans-serif;font-size:16px;text-align:center;mso-border-alt:none;word-break:keep-all;"><span style="padding-left:20px;padding-right:20px;font-size:16px;display:inline-block;letter-spacing:normal;"><span dir="ltr" style="margin: 0; word-break: break-word; line-height: 32px;">Read More</span></span></a><!--[if mso]></center></v:textbox></v:roundrect><![endif]--></div> </td> </tr> </table> </td> </tr> </tbody> </table> </td> </tr> </tbody> </table> <table class="row row-3" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tbody> <tr> <td> <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-radius: 0; color: #000000; width: 745px;" width="745"> <tbody> <tr> <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 5px; padding-top: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;"> <table class="divider_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div class="alignment" align="center"> <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 1px solid #dddddd;"><span>&#8202;</span></td> </tr> </table> </div> </td> </tr> </table> <table class="paragraph_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;"> <tr> <td class="pad"> <div style="color:#101112;direction:ltr;font-family:Arial, Helvetica, sans-serif;font-size:16px;font-weight:400;letter-spacing:0px;line-height:120%;text-align:center;mso-line-height-alt:19.2px;"> <p style="margin: 0;"><table border="0" cellpadding="0" cellspacing="0" style="margin-left: auto; margin-right: auto;"><tr><td colspan="2"><a href="https://sli.summitdaily.com/click?s=754067&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=default" rel="nofollow"><img src="https://sli.summitdaily.com/imp?s=754067&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=default" border="0" width="740" style="width: 100%; max-width: 740px !important;"/></a></td></tr><tr><td align="left"><a style="display: block; max-width: 116px;  max-height: 15px;" href="https://sli.summitdaily.com/click?s=754068&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=static" rel="nofollow"><img src="https://sli.summitdaily.com/imp?s=754068&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=static" border="0"/></a></td><td align="right"><a style="display: block; max-width: 19px;  max-height: 15px;" href="https://sli.summitdaily.com/click?s=754070&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=static" rel="nofollow"><img src="https://sli.summitdaily.com/imp?s=754070&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=static" border="0"/></a></td></tr></table></p> </div> </td> </tr> </table> <table class="divider_block block-3" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div class="alignment" align="center"> <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 1px solid #dddddd;"><span>&#8202;</span></td> </tr> </table> </div> </td> </tr> </table> </td> </tr> </tbody> </table> </td> </tr> </tbody> </table> <table class="row row-4" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #f6f6f6;"> <tbody> <tr> <td> <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000000; width: 745px;" width="745"> <tbody> <tr> <td class="column column-1" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 5px; padding-top: 5px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;"> <table class="divider_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div class="alignment" align="center"> <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 1px solid #dddddd;"><span>&#8202;</span></td> </tr> </table> </div> </td> </tr> </table> <table class="text_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;"> <tr> <td class="pad"> <div style="font-family: sans-serif"> <div class style="font-size: 12px; font-family: Arial, \'Helvetica Neue\', Helvetica, sans-serif; mso-line-height-alt: 14.399999999999999px; color: #C0C0C0; line-height: 1.2;"> <p style="margin: 0; font-size: 12px; text-align: center; mso-line-height-alt: 14.399999999999999px;"><span style="color:#C0C0C0;">Copyright ? 2023 Summit Daily News, All rights reserved.You are receiving this email because you have provided your email address to Summit Daily. If you would no longer like to receive emails from Summit Daily, please click on the \\\\\\\&#039;Email Subscriptions\\\\\\\&#039; link below to manage your email subscriptions.<br><br>Where to find us:<br>P.O. Box 329 Frisco, CO 80443<br><br>Changed your mind? You can <a ses:tags="unsubscribeLinkTag:click;" href="https://www.summitdaily.com/myprofile" target="_blank" style="color:#c0c0c0;" rel="noopener">unsubscribe</a> at any time.</span></p> </div> </div> </td> </tr> </table> <table class="html_block block-3" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;"> <tr> <td class="pad"> <div style="font-family:Arial, \'Helvetica Neue\', Helvetica, sans-serif;text-align:center;" align="center"><div style="height-top: 20px;"><table cellpadding="0" cellspacing="0" border="0" width="40" height="6"><tbody><tr><td><img src="https://sli.summitdaily.com/imp?s=126043800&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=pixel" width="2" height="6" border="0" /></td><td><img src="https://sli.summitdaily.com/imp?s=126043801&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=pixel" width="2" height="6" border="0" /></td><td><img src="https://sli.summitdaily.com/imp?s=126043802&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=pixel" width="2" height="6" border="0" /></td><td><img src="https://sli.summitdaily.com/imp?s=126043803&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=pixel" width="2" height="6" border="0" /></td><td><img src="https://sli.summitdaily.com/imp?s=126043804&li=1b7312a97a254015b45e3a52875e1f82&e={{Address}}&p=TG9jYWxOZXdzRmxhc2gyMDIzLTA2LTAyIDE0OjE2OjAw&stpe=pixel" width="2" height="6" border="0" /></td></tr></tbody></table></div></div> </td> </tr> </table> </td> </tr> </tbody> </table> </td> </tr> </tbody> </table> </td> </tr> </tbody> </table><!-- End --> </body> </html>';

// echo "Campaign Title: ".$campaignTitle."\n";
// echo "Subject: ".$subject."\n";
// echo "Segment ID: ".$segmentID."\n";
// echo "Send Time: ".$sendTime."\n";
// echo "Frequency: ".$frequency."\n";
// echo "End On: ".$endOn."\n";
// echo "End Date: ".$endDate."\n";
// echo "From Address: ".getFrom()."\n";
// echo "App ID: ".global_config('pinAppID')."\n";
// echo "Template: ".stripslashes($newsl_content)."\n";

$options = array(
  'ignore_errors' => true,
  // other options go here
);

$emailText = \Soundasleep\Html2Text::convert(stripslashes($newsl_content), $options);

    // Determine target segment - use Nobody segment as failsafe when pausing
    $targetSegmentID = $skipDate ? global_config('nobodySegmentID') : $segmentID;
    $targetSegmentName = $skipDate ? 'Nobody (Safety Segment)' : $segmentName;

    logMessage('INFO', 'Preparing Pinpoint API createCampaign request', [
        'SegmentId' => substr($targetSegmentID, 0, 8) . '...',
        'SegmentName' => $targetSegmentName,
        'IsPaused' => $skipDate ? 'TRUE' : 'FALSE',
        'Name' => substr($campaignTitle,0,63),
        'Frequency' => $frequency,
        'StartTime' => date('c', strtotime($sendTime)),
        'hasContent' => strlen($newsl_content) > 10 ? 'yes' : 'no'
    ]);

    if($skipDate) {
        logMessage('WARN', 'Campaign will be created in PAUSED state with Nobody segment', [
            'IsPaused' => 'true',
            'originalSegment' => $segmentName . ' (' . substr($segmentID, 0, 8) . '...)',
            'switchedToSegment' => 'Nobody (Safety) (' . substr($targetSegmentID, 0, 8) . '...)',
            'protection' => 'DOUBLE - Paused + Empty Audience'
        ]);
    } else {
        logMessage('SUCCESS', 'Campaign will be created ACTIVE with real audience', [
            'IsPaused' => 'false',
            'SegmentId' => substr($targetSegmentID, 0, 8) . '...',
            'SegmentName' => $segmentName
        ]);
    }

    $result = $client->createCampaign([
        'ApplicationId' => global_config('pinAppID'), // REQUIRED
        'WriteCampaignRequest' => [ // REQUIRED
          'SegmentId' => $targetSegmentID,
          'Description' => 'Campaign for '.$campaignTitle,
            'IsPaused' => $skipDate,
            'MessageConfiguration' => [
                'EmailMessage' => [
                  'Body' => $emailText,
                  'HtmlBody' => stripslashes($newsl_content),
                  'FromAddress' => getFrom(),
                  'Title' => df_email_sanitize(stripslashes($subject)),
                ],
            ],
            'Name' => substr($campaignTitle,0,63),
            'Schedule' => [
                'IsLocalTime' => false,
                'StartTime' => date('c', strtotime($sendTime)),
                'Frequency' => $frequency,
                'EndTime' => date('c',strtotime('2099-12-31 23:59:59')),
            ]

            // 'SegmentVersion' => 'latest',
        ],
    ]);
    // print_r($result);

    $campaignID = $result['CampaignResponse']['Id'];
    $campaignStatus = $result['CampaignResponse']['State']['CampaignStatus'];

    logMessage('SUCCESS', 'Pinpoint createCampaign API call completed', [
        'campaignID' => $campaignID,
        'campaignStatus' => $campaignStatus,
        'isPaused' => $skipDate ? 'yes' : 'no'
    ]);

    if($campaignStatus != ''){
      // Note: Do NOT update sendTime in SQL - it should remain at the original intended time
      // The script modifies $sendTime in memory for Pinpoint, but the DB should keep the original schedule
      $updateSQL = "UPDATE ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_schedules SET campaignID = '$campaignID', campaignStatus = '$campaignStatus' WHERE id = $id";
      $conn->query($updateSQL);

      logMessage('INFO', 'Database updated with campaign details', [
          'scheduleID' => $id,
          'campaignID' => $campaignID,
          'campaignStatus' => $campaignStatus
      ]);
    }
    


}

/**
 * Summary of updateCampaign
 * @param mixed $id
 * @param mixed $subjectType
 * @param mixed $newsletterID
 * @param mixed $newsletterName
 * @param mixed $sendTime
 * @param mixed $segmentID
 * @param mixed $emailTemplate
 * @param mixed $pinTemplateName
 * @param mixed $newsletterSubject
 * @param mixed $firstHeadline
 * @param mixed $lastHeadline
 * @return void
 */
function updateCampaign($id,$campaignID,$subjectType,$newsletterID,$newsletterName,$sendTime,$segmentID,$emailTemplate,$pinTemplateName,$newsletterSubject,$firstHeadline,$lastHeadline,$frequency,$endOn,$endDate,$segmentName,$templateName,$category,$newsletterType,$newsletterDisplayName,$preHeader,$feedURL,$customSubject,$manualNewsletterID,$skipDate=false,$lastSendDate=null){
  global $client;
  global $conn;

  echo "Updating Campaign: ".$newsletterDisplayName."\n\n";
echo "Send Date: ".$sendTime."\n";

  logMessage('INFO', '--- updateCampaign() START ---', [
      'campaignID' => $campaignID,
      'newsletterDisplayName' => $newsletterDisplayName,
      'skipDate' => $skipDate,
      'segmentID' => substr($segmentID, 0, 8) . '...',
      'segmentName' => $segmentName,
      'sendTime' => $sendTime,
      'frequency' => $frequency,
      'lastSendDate' => $lastSendDate
  ]);

if($skipDate){
  // Provide minimal HTML content for paused campaigns (AWS Pinpoint requires Body/HtmlBody)
  // This will never be sent (campaign is paused + Nobody segment), but API needs valid content
  $newsl_content = "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>Newsletter Paused</title></head><body><p>This newsletter has been paused due to no new content available.</p></body></html>";

  logMessage('DEBUG', 'Using placeholder content for paused campaign', [
      'note' => 'Campaign is paused and uses Nobody segment - this content will not be sent'
  ]);
}else{
  $newsl_content = getNewsletter($newsletterID,$emailTemplate,$segmentID,$pinTemplateName,$sendTime,$newsletterName,$category,$newsletterType,$newsletterDisplayName,$preHeader,$feedURL,$manualNewsletterID,false,$lastSendDate);

  // Sanitize email content to fix smart quotes, &nbsp; issues, etc.
  $newsl_content = df_email_content_sanitize($newsl_content);

  logMessage('DEBUG', 'Email content sanitized', [
      'note' => 'Cleaned smart quotes, excess &nbsp;, and special characters'
  ]);
}
  // echo stripslashes($newsl_content);
  
  $campaignTitle = stripslashes($newsletterDisplayName);
  if($subjectType == 'Newsletter'){
    $subject = $newsletterSubject;
  }else if($subjectType == 'First Headline'){
    $subject = $firstHeadline;
  }else if($subjectType == 'Last Headline'){
    $subject = $lastHeadline;
  }else if($subjectType == 'Custom'){
    $subject = $customSubject;
  }

  // Log subject before and after sanitization
  $subjectBefore = stripslashes($subject);
  $subjectAfter = df_email_sanitize($subjectBefore);
  if($subjectBefore !== $subjectAfter) {
      logMessage('DEBUG', 'Subject sanitized - HTML entities/whitespace cleaned', [
          'before' => substr($subjectBefore, 0, 100),
          'after' => substr($subjectAfter, 0, 100),
          'subjectType' => $subjectType
      ]);
  }

  // echo "First Headline: ".$firstHeadline."\n";
  // echo "Last Headline: ".$lastHeadline."\n";
  // $subject = preg_replace('/[[:^print:]]/', '', $subject);

  // $subject = str_replace("—", "-", $subject);

  // $subject = mb_convert_encoding($subject, 'UTF-8');
  // $subject = iconv('UTF-8', 'ASCII//TRANSLIT', $subject);

  // echo "Subject: ".$subject."\n";
  // echo "Segment ID: ".$segmentID."\n";
  // echo "Send Time: ".$sendTime."\n";
  // echo "From Address: ".getFrom()."\n";
  // echo "App ID: ".global_config('pinAppID')."\n";
  // // echo "Template: ".stripslashes($newsl_content)."\n";
  // echo "Campaign ID: ".$campaignID."\n";
  // echo "Campaign Title: ".$campaignTitle."\n";
  // echo "End Date: ".date('c',strtotime('+1 year'))."\n";
    // echo stripslashes($newsl_content);

    $options = array(
      'ignore_errors' => true,
      // other options go here
    );

  $emailText = \Soundasleep\Html2Text::convert(stripslashes($newsl_content), $options);

    // Determine target segment - use Nobody segment as failsafe when pausing
    $targetSegmentID = $skipDate ? global_config('nobodySegmentID') : $segmentID;
    $targetSegmentName = $skipDate ? 'Nobody (Safety Segment)' : $segmentName;

    logMessage('INFO', 'Preparing Pinpoint API updateCampaign request', [
        'campaignID' => $campaignID,
        'SegmentId' => substr($targetSegmentID, 0, 8) . '...',
        'SegmentName' => $targetSegmentName,
        'IsPaused' => $skipDate ? 'TRUE' : 'FALSE',
        'Name' => substr($campaignTitle,0,63),
        'Frequency' => $frequency,
        'StartTime' => date('c', strtotime($sendTime)),
        'hasContent' => strlen($newsl_content) > 10 ? 'yes' : 'no'
    ]);

    if($skipDate) {
        logMessage('WARN', 'Campaign will be updated to PAUSED state with Nobody segment', [
            'campaignID' => $campaignID,
            'IsPaused' => 'true',
            'originalSegment' => $segmentName . ' (' . substr($segmentID, 0, 8) . '...)',
            'switchedToSegment' => 'Nobody (Safety) (' . substr($targetSegmentID, 0, 8) . '...)',
            'protection' => 'DOUBLE - Paused + Empty Audience',
            'note' => 'Campaign will be restored to real segment when content available'
        ]);
    } else {
        logMessage('SUCCESS', 'Campaign will be UNPAUSED with fresh content and RESTORED to real audience', [
            'campaignID' => $campaignID,
            'IsPaused' => 'false',
            'SegmentId' => substr($targetSegmentID, 0, 8) . '...',
            'SegmentName' => $segmentName,
            'note' => 'Automatically switching back from Nobody segment'
        ]);
    }

    $result = $client->updateCampaign([
        'ApplicationId' => global_config('pinAppID'), // REQUIRED
        'CampaignId' => $campaignID,
        'WriteCampaignRequest' => [ // REQUIRED
            'Description' => 'string',
            'IsPaused' => $skipDate,
            'MessageConfiguration' => [
                'EmailMessage' => [
                    'Body' => $emailText,
                    'HtmlBody' => stripslashes($newsl_content),
                    'FromAddress' => getFrom(),
                    'Title' => df_email_sanitize(stripslashes($subject)),
                ],
            ],
            'Name' => substr($campaignTitle,0,63),
            'Schedule' => [
                'IsLocalTime' => false,
                'StartTime' => date('c', strtotime($sendTime)),
                'Frequency' => $frequency,
                'EndTime' => date('c',strtotime('+1 year')),
            ],
            'SegmentId' => $targetSegmentID,
            'SegmentVersion' => 1,
        ],
    ]);
    // print_r($result);
    $campaignStatus = $result['CampaignResponse']['State']['CampaignStatus'];

    logMessage('SUCCESS', 'Pinpoint updateCampaign API call completed', [
        'campaignID' => $campaignID,
        'campaignStatus' => $campaignStatus,
        'isPaused' => $skipDate ? 'yes' : 'no'
    ]);

    if($campaignStatus != ''){
      // Note: Do NOT update sendTime in SQL - it should remain at the original intended time
      // The script modifies $sendTime in memory for Pinpoint, but the DB should keep the original schedule
      $updateSQL = "UPDATE ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_schedules SET campaignStatus = '$campaignStatus' WHERE id = $id";
      $conn->query($updateSQL);

      logMessage('INFO', 'Database updated with campaign status', [
          'scheduleID' => $id,
          'campaignID' => $campaignID,
          'campaignStatus' => $campaignStatus
      ]);
    }

}


/**
 * Summary of cleanString
 * @param mixed $string
 * @return array|string
 */
function cleanString($string) {
  // echo "Clean String\n";
    // Remove special characters
    $string = preg_replace('/[^A-Za-z0-9\-]/', '', $string);

    // Replace spaces with underscores
    $string = str_replace(' ', '_', $string);

    return $string;
}

/**
 * Enhanced logging function with timestamp, level, and context
 * @param string $level Log level (INFO, WARN, ERROR, SUCCESS, DEBUG)
 * @param string $message Main log message
 * @param array $context Additional context as key-value pairs
 */
function logMessage($level, $message, $context = []) {
    $timestamp = date('Y-m-d H:i:s');
    $levelEmoji = [
        'INFO' => 'ℹ️',
        'WARN' => '⚠️',
        'ERROR' => '❌',
        'SUCCESS' => '✅',
        'DEBUG' => '🔍'
    ];
    $emoji = isset($levelEmoji[$level]) ? $levelEmoji[$level] : '•';

    $contextStr = '';
    if (!empty($context)) {
        $contextPairs = [];
        foreach ($context as $key => $value) {
            if (is_array($value)) {
                $value = json_encode($value);
            } elseif (is_bool($value)) {
                $value = $value ? 'true' : 'false';
            } elseif (is_null($value)) {
                $value = 'null';
            }
            // Truncate long values
            if (strlen($value) > 100) {
                $value = substr($value, 0, 97) . '...';
            }
            $contextPairs[] = "$key=$value";
        }
        $contextStr = ' | ' . implode(', ', $contextPairs);
    }

    $logLine = "[$timestamp] $emoji $level: $message$contextStr\n";
    echo $logLine;
    error_log($logLine);
}

function most_recent_previous_day_of_week($current_day, $desired_days) {
  $days = array('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY');
  $current_day_index = array_search($current_day, $days);
  
  $days_to_subtract = PHP_INT_MAX;
  $most_recent_date = null;
  foreach ($desired_days as $desired_day) {
      $desired_day_index = array_search($desired_day, $days);
      $days_diff = $current_day_index - $desired_day_index;
      if ($days_diff <= 0) {
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
 * Summary of next_day_of_week
 * @param mixed $current_day
 * @param mixed $desired_days
 * @return string
 */
function next_day_of_week($current_day, $desired_days, $effectiveDate) {
  $days = array('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY');
  $current_day_index = array_search($current_day, $days);
  // echo "Current Day Index: ".$current_day_index."\n";
  // error_log("Current Day Index: ".$current_day_index);
  
  $days_to_add = PHP_INT_MAX;
  // print_r($desired_days);
  foreach ($desired_days as $desired_day) {
      // echo "Desired Day: ".$desired_day."\n";
      $desired_day_index = array_search($desired_day, $days);
      // echo "Desired Day Index: ".$desired_day_index."\n";
      $days_diff = $desired_day_index - $current_day_index;
      if ($days_diff < 0) {
          $days_diff += 7;
      }
      if ($days_diff < $days_to_add) {
          $days_to_add = $days_diff;
      }
  }
  
  $next_date = date('Y-m-d', strtotime($effectiveDate."+$days_to_add days"));
  return $next_date;
}


// ============================================================================
// NEW SCRIPT RUN STARTING
// ============================================================================
logMessage('INFO', '═══════════════════════════════════════════════════════════════════════════');
logMessage('INFO', '                    NEW SCRIPT RUN STARTING                                ');
logMessage('INFO', '═══════════════════════════════════════════════════════════════════════════');
logMessage('INFO', 'Script execution started', [
    'timestamp' => date('Y-m-d H:i:s'),
    'marketCode' => $marketCode ?? 'unknown',
    'configFile' => basename($confFile ?? '')
]);

$nowTime = date('Y-m-d 00:00:00');
// echo $nowTime;
$nowDate = date('Y-m-d');
$scheduleSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_schedules where ((frequency != 'Custom' and sendTime <= '".date('Y-m-d H:i:s',strtotime('+10 minutes'))."') or (frequency = 'Custom')) and (endOn = 'Never' or endDate >= $nowDate)";
// echo $scheduleSQL;
$scheduleResult = $conn->query($scheduleSQL);
// print_r($scheduleResult);
// echo $scheduleSQL;

foreach($scheduleResult as $schedule){
  
  // echo "Schedule\n";
  // print_r($schedule) . "\n";
    $id = $schedule['id'];
    $campaignID = $schedule['campaignID'];
    $subjectType = $schedule['subject'];
    $newsletterType = $schedule['newsletterType'];
    $newsletterID = $schedule['id'];
    $manualNewsletterID = $schedule['newsletterID'];
    $sendTime = $schedule['sendTime'];
    $endOn = $schedule['endOn'];
    $endDate = $schedule['endDate'];
    $frequency = $schedule['frequency'];
    $segmentID = $schedule['segmentID'];
    $templateName = $schedule['templateName'];
    $timezone = $schedule['timezone'];
    $newsletterName = $schedule['newsletterName'];
    $segmentName = $schedule['segmentName'];
    $category = $schedule['category'];
    $newsletterDisplayName = $schedule['newsletterDisplayName'];
    $customFrequency = ($schedule['customFrequency'] != null) ? unserialize($schedule['customFrequency']) : '';
    $preHeader = $schedule['preHeader'];
    $feedURL = $schedule['feedURL'];
    $customSubject = $schedule['customSubject'];
    $scheduleWeekday = strtoupper(date('l', strtotime($sendTime)));
    $currentWeekday = strtoupper(date('l'));
    
    // echo "Prcoessing Schedule: ".$newsletterDisplayName."\n";
    echo "Prcoessing Schedule: ".$newsletterDisplayName." for segment ".$segmentName." and segmentID ".$segmentID."\n";

    logMessage('INFO', '========================================');
    logMessage('INFO', 'Processing newsletter schedule', [
        'id' => $id,
        'name' => $newsletterDisplayName,
        'type' => $newsletterType,
        'frequency' => $frequency,
        'segmentName' => $segmentName,
        'segmentID' => substr($segmentID, 0, 8) . '...',
        'sendTime' => $sendTime,
        'campaignID' => $campaignID ?? 'none'
    ]);

    $templateSQL = "SELECT * FROM ".global_config('wpTablePrefix')."aws_pinpoint_newsletter_templates WHERE templateName = '$templateName'";
    $templateResult = $conn->query($templateSQL);
    $template = $templateResult->fetch_assoc();
    $emailTemplate = $template['emailTemplate'];
    $pinTemplateName = global_config('pinSiteCode')."_".cleanString($templateName);
    
    if($newsletterType == 'Manual'){
      logMessage('INFO', 'Manual newsletter - fetching configured stories', [
          'manualNewsletterID' => $manualNewsletterID
      ]);

      $newsletterSQL = "SELECT pm1.meta_value as subject, pm2.meta_value as storyCount
      FROM ".global_config('wpTablePrefix')."postmeta pm1
      JOIN ".global_config('wpTablePrefix')."postmeta pm2 ON pm1.post_id = pm2.post_id
      WHERE pm1.meta_key = 'newsletter_subject'
      AND pm2.meta_key = 'newsletter_stories'
      AND pm1.post_id  = $manualNewsletterID;";
// echo $newsletterSQL;
      $newsletterResult = $conn->query($newsletterSQL);
      $newsletter = $newsletterResult->fetch_assoc();
      $newsletterSubject = $newsletter['subject'];
      $storyCount = $newsletter['storyCount'];

      logMessage('DEBUG', 'Newsletter metadata fetched', [
          'subject' => $newsletterSubject,
          'storyCount' => $storyCount
      ]);

      $lastStoryKey = $storyCount - 1;
      $lastStoryMetaKey = "newsletter_stories_".$lastStoryKey."_newsletter_story";

      $headlineSQL = "SELECT pm1.meta_value as key1_value, PO1.post_title as firstHeadline, pm2.meta_value as key2_value, PO2.post_title as lastHeadline
      FROM ".global_config('wpTablePrefix')."postmeta pm1
      JOIN ".global_config('wpTablePrefix')."postmeta pm2 ON pm1.post_id = pm2.post_id
      LEFT JOIN ".global_config('wpTablePrefix')."posts PO1 ON PO1.ID = pm1.meta_value
      LEFT JOIN ".global_config('wpTablePrefix')."posts PO2 ON PO2.ID = pm2.meta_value
      WHERE pm1.meta_key = 'newsletter_stories_0_newsletter_story'
      AND pm2.meta_key = '".$lastStoryMetaKey."'
      AND pm1.post_id  = $manualNewsletterID;";
      // echo $headlineSQL."\n";

      logMessage('DEBUG', 'Querying for headline posts');
      $headlineResult = $conn->query($headlineSQL);
      $resultCount = $headlineResult->num_rows;

      logMessage('INFO', 'Manual newsletter content query results', [
          'rowCount' => $resultCount,
          'expectedStories' => $storyCount
      ]);

      if($resultCount > 0) {
          $headline = $headlineResult->fetch_assoc();
          $firstHeadline = $headline['firstHeadline'];
          $lastHeadline = $headline['lastHeadline'];
          $skipDate = false;

          logMessage('SUCCESS', 'Manual newsletter has content', [
              'firstHeadline' => $firstHeadline,
              'lastHeadline' => $lastHeadline,
              'skipDate' => false
          ]);
      } else {
          $firstHeadline = '';
          $lastHeadline = '';
          $skipDate = true;

          logMessage('WARN', 'Manual newsletter has NO stories configured - will pause', [
              'manualNewsletterID' => $manualNewsletterID,
              'skipDate' => true
          ]);
      }

      // Set $lastSendDate for Manual newsletters (same logic as Category/Feed)
      if($frequency == 'DAILY'){
        $lastSendDate = date('Y-m-d H:i:s', strtotime('-1 day', mktime(date('H',strtotime($sendTime)), date('i',strtotime($sendTime)), date('s',strtotime($sendTime)), date('m'), date('d'), date('Y'))));
      }elseif($frequency == 'WEEKLY'){
        $lastSendDate = date('Y-m-d H:i:s', strtotime('-1 week', mktime(date('H',strtotime($sendTime)), date('i',strtotime($sendTime)), date('s',strtotime($sendTime)), date('m'), date('d'), date('Y'))));
      }elseif($frequency == 'MONTHLY'){
        $lastSendDate = date('Y-m-d H:i:s', strtotime('-1 month', mktime(date('H',strtotime($sendTime)), date('i',strtotime($sendTime)), date('s',strtotime($sendTime)), date('m'), date('d'), date('Y'))));
      }elseif($frequency == 'CUSTOM'){
        $today = strtoupper(date('l'));
        $desired_days = $customFrequency;
        $lastSendDate = most_recent_previous_day_of_week($today, $desired_days).date(' H:i:s', strtotime($sendTime));
      }
    }elseif($newsletterType == 'Category'){

      if($frequency == 'DAILY'){
        $lastSendDate = date('Y-m-d H:i:s', strtotime('-1 day', mktime(date('H',strtotime($sendTime)), date('i',strtotime($sendTime)), date('s',strtotime($sendTime)), date('m'), date('d'), date('Y'))));
      }elseif($frequency == 'WEEKLY'){
        $lastSendDate = date('Y-m-d H:i:s', strtotime('-1 week', mktime(date('H',strtotime($sendTime)), date('i',strtotime($sendTime)), date('s',strtotime($sendTime)), date('m'), date('d'), date('Y'))));
      }elseif($frequency == 'MONTHLY'){
        $lastSendDate = date('Y-m-d H:i:s', strtotime('-1 month', mktime(date('H',strtotime($sendTime)), date('i',strtotime($sendTime)), date('s',strtotime($sendTime)), date('m'), date('d'), date('Y'))));
      }elseif($frequency == 'CUSTOM'){
        $today = strtoupper(date('l')); // Get the current day of the week
        $desired_days = $customFrequency;
        // if !$current_day then error_log the blog id and newsletter name
        // if(empty($current_day)){
        //   error_log("Campaign ID: ".$campaignID." - Newsletter Name: ".$newsletterDisplayName . " - Segment ID: ".$segmentID);
        // }
        $current_day = strtoupper(date('l')); // Get the current day of the week
        $lastSendDate = most_recent_previous_day_of_week($current_day, $desired_days).date(' H:i:s');;        
      }

      echo "Last Send Date: ".$lastSendDate."\n";

      logMessage('INFO', 'Category newsletter - querying WordPress posts', [
          'category' => $category,
          'lookbackStart' => $lastSendDate,
          'lookbackNow' => date('Y-m-d H:i:s')
      ]);

      $headlineSQL = "SELECT
      MIN(".global_config('wpTablePrefix')."posts.post_title) AS first_post_title,
      MAX(".global_config('wpTablePrefix')."posts.post_title) AS last_post_title
      FROM ".global_config('wpTablePrefix')."posts
      INNER JOIN ".global_config('wpTablePrefix')."term_relationships ON ".global_config('wpTablePrefix')."posts.ID = ".global_config('wpTablePrefix')."term_relationships.object_id
      INNER JOIN ".global_config('wpTablePrefix')."terms ON ".global_config('wpTablePrefix')."term_relationships.term_taxonomy_id = ".global_config('wpTablePrefix')."terms.term_id
      WHERE ".global_config('wpTablePrefix')."terms.slug = '".$category."' AND ".global_config('wpTablePrefix')."posts.post_type = 'post' AND ".global_config('wpTablePrefix')."posts.post_status = 'publish' and post_date > '".$lastSendDate."'
      ORDER BY ".global_config('wpTablePrefix')."posts.post_date DESC
      LIMIT 1";
      echo $headlineSQL."\n";

      logMessage('DEBUG', 'Executing WordPress content query for category', [
          'sql' => strlen($headlineSQL) . ' chars'
      ]);

      $headlineResult = $conn->query($headlineSQL);
      $contentCount = $headlineResult->num_rows;

      logMessage('INFO', 'Category newsletter content query results', [
          'category' => $category,
          'rowCount' => $contentCount,
          'lookbackPeriod' => $lastSendDate . ' to ' . date('Y-m-d H:i:s')
      ]);

      if($contentCount > 0) {
          $headline = $headlineResult->fetch_assoc();
          $firstHeadline = $headline['first_post_title'];
          $lastHeadline = $headline['last_post_title'];

          // Check if we actually got content (MIN/MAX aggregate can return NULL when no posts match)
          if($firstHeadline !== null && $firstHeadline !== '') {
              $newsletterSubject = '';
              $skipDate = false;

              logMessage('SUCCESS', 'Category newsletter has NEW content to send', [
                  'postCount' => $contentCount,
                  'firstHeadline' => $firstHeadline,
                  'lastHeadline' => $lastHeadline,
                  'skipDate' => false
              ]);

              if($category == 'devtest' && !empty($firstHeadline)){
                echo "firstHeadline: ".$firstHeadline. "\n";
              }
          } else {
              // No actual posts found (MIN/MAX returned NULL because no posts matched WHERE clause)
              $firstHeadline = '';
              $lastHeadline = '';
              $newsletterSubject = '';
              $skipDate = true;

              logMessage('WARN', 'Category newsletter has NO new content - will PAUSE campaign', [
                  'category' => $category,
                  'lookbackStart' => $lastSendDate,
                  'rowCount' => $contentCount,
                  'note' => 'Query returned row but post_title is NULL (no matching posts in date range)',
                  'skipDate' => true,
                  'action' => 'Campaign will be paused and send time advanced'
              ]);
          }
      } else {
          $firstHeadline = '';
          $lastHeadline = '';
          $newsletterSubject = '';
          $skipDate = true;

          logMessage('WARN', 'Category newsletter has NO new content - will PAUSE campaign', [
              'category' => $category,
              'lookbackStart' => $lastSendDate,
              'rowCount' => 0,
              'skipDate' => true,
              'action' => 'Campaign will be paused and send time advanced'
          ]);
      }

      echo "Skip Date: ".$skipDate."\n";
    }elseif($newsletterType == 'Feed'){

      if($frequency == 'DAILY'){
        $lastSendDate = date('Y-m-d H:i:s', strtotime('-1 day', mktime(date('H',strtotime($sendTime)), date('i',strtotime($sendTime)), date('s',strtotime($sendTime)), date('m'), date('d'), date('Y'))));
      }elseif($frequency == 'WEEKLY'){
        $lastSendDate = date('Y-m-d H:i:s', strtotime('-1 week', mktime(date('H',strtotime($sendTime)), date('i',strtotime($sendTime)), date('s',strtotime($sendTime)), date('m'), date('d'), date('Y'))));
      }elseif($frequency == 'MONTHLY'){
        $lastSendDate = date('Y-m-d H:i:s', strtotime('-1 month', mktime(date('H',strtotime($sendTime)), date('i',strtotime($sendTime)), date('s',strtotime($sendTime)), date('m'), date('d'), date('Y'))));
      }elseif($frequency == 'CUSTOM'){
        $today = strtoupper(date('l')); // Get the current day of the week
        $desired_days = $customFrequency;
        $lastSendDate = most_recent_previous_day_of_week($today, $desired_days).date(' H:i:s');;        
      }

      $streamContext = stream_context_create(
          array('http'=>
              array(
                  'timeout' => 10,  
              ),
              'ssl' => array(
              'verify_peer' => false, // You could skip all of the trouble by changing this to false, but it's WAY uncool for security reasons.
          )
          )
      );


      $feedURLArray = explode(",", $feedURL);
        
      if (count($feedURLArray) > 1) {
          $firstFeedURL = trim($feedURLArray[0]);
          $firstFeed = file_get_contents($firstFeedURL, false, $streamContext);
          $combinedFeed = simplexml_load_string($firstFeed);
      
          for ($i = 1; $i < count($feedURLArray); $i++) {
              $newFeedURL = trim($feedURLArray[$i]);
              $feed = file_get_contents($newFeedURL, false, $streamContext);
              $xml = simplexml_load_string($feed);
      
              foreach ($xml->channel->item as $item) {
                  $combinedFeed->channel->addChild('item');
                  $combinedFeed->channel->item[] = $item;
              }
          }
      
          $xml = $combinedFeed;
      } else {
          $newFeedURL = trim($feedURLArray[0]);
          $feed = file_get_contents($newFeedURL, false, $streamContext);
          try {
              $xml = simplexml_load_string($feed);
          } catch (Exception $e) {
              echo "Error: ".$e->getMessage()."\n";
              echo "Feed URL: ".$newFeedURL."\n";
              echo "Feed: ".$feed."\n";
          }
          
          $errors = libxml_get_errors();
          if ($errors) {
            foreach ($errors as $error) {
              echo "Error: " . $error->message . "\n";
            }
            libxml_clear_errors();
          }
          
          // $xml = simplexml_load_string($feed);
        }


      $xmlCount = count($xml->channel->item);
      $skipDate = ($xmlCount == 0) ? true : false;

      logMessage('INFO', 'Feed newsletter content fetched', [
          'feedURL' => strlen($feedURL) > 50 ? substr($feedURL, 0, 47) . '...' : $feedURL,
          'itemCount' => $xmlCount,
          'skipDate' => $skipDate
      ]);

      if($skipDate == false){
        $firstHeadline = (string)$xml->channel->item[0]->title;
        $lastHeadline = (string)$xml->channel->item[$xmlCount - 1]->title;
        $newsletterSubject = '';

        logMessage('SUCCESS', 'Feed newsletter has content to send', [
            'itemCount' => $xmlCount,
            'firstHeadline' => $firstHeadline,
            'lastHeadline' => $lastHeadline
        ]);
      }else{
        $firstHeadline = '';
        $lastHeadline = '';
        $newsletterSubject = '';

        logMessage('WARN', 'Feed newsletter has NO content - will pause', [
            'feedURL' => strlen($feedURL) > 50 ? substr($feedURL, 0, 47) . '...' : $feedURL,
            'skipDate' => true
        ]);
      }
    }
    

// echo $newsletterDisplayName.": minus 10 mins - ".date('H:i:s', strtotime($sendTime) - 600)."\n";
// echo $newsletterDisplayName.": minus 5 mins - ".date('H:i:s', strtotime($sendTime) - 300)."\n";
// echo date('H:i:s')."\n";
// echo $frequency."\n";
// echo $endOn."\n";

if($frequency == 'CUSTOM'){
  $sendFrequency = 'DAILY';
}else if($frequency == 'WEEKLY'){
  $sendFrequency = 'WEEKLY';
}else if($frequency == 'MONTHLY'){
  $sendFrequency = 'MONTHLY';
}else{
  $sendFrequency = 'DAILY';
}
    // Check if we're in the send window (10-5 minutes before scheduled time)
    $currentTime = date('H:i:s');
    $windowStart = date('H:i:s', strtotime($sendTime) - 600);
    $windowEnd = date('H:i:s', strtotime($sendTime) - 300);
    $inTimeWindow = ($currentTime >= $windowStart && $currentTime <= $windowEnd);

    // Check frequency conditions
    $frequencyMatch = false;
    if($frequency == 'DAILY') {
        $frequencyMatch = true;
    } elseif($frequency == 'WEEKLY' && $scheduleWeekday == $currentWeekday) {
        $frequencyMatch = true;
    } elseif($frequency == 'MONTHLY' && date('d', strtotime($sendTime)) == date('d')) {
        $frequencyMatch = true;
    } elseif($frequency == 'CUSTOM' && in_array($currentWeekday, $customFrequency)) {
        $frequencyMatch = true;
    }

    // Check end date
    $endDateOk = ($endOn == 'never' || $endDate >= $nowDate);

    $shouldProcess = $frequencyMatch && $endDateOk && $inTimeWindow;

    logMessage('DEBUG', 'Send window evaluation', [
        'currentTime' => $currentTime,
        'windowStart' => $windowStart,
        'windowEnd' => $windowEnd,
        'inTimeWindow' => $inTimeWindow,
        'frequencyMatch' => $frequencyMatch,
        'endDateOk' => $endDateOk,
        'shouldProcess' => $shouldProcess
    ]);

    if($shouldProcess){
      logMessage('INFO', '>>> IN SEND WINDOW - Processing campaign <<<');

      if($skipDate){
        logMessage('WARN', 'Skipping send due to no content - advancing send time', [
            'currentSendTime' => $sendTime
        ]);
        // Advance from the ORIGINAL sendTime, not from NOW, to preserve time of day
        if($frequency == 'DAILY'){
          $sendTime = date('Y-m-d H:i:s', strtotime('+1 day', strtotime($sendTime)));
        }elseif($frequency == 'WEEKLY'){
          $sendTime = date('Y-m-d H:i:s', strtotime('+1 week', strtotime($sendTime)));
        }elseif($frequency == 'MONTHLY'){
          $sendTime = date('Y-m-d H:i:s', strtotime('+1 month', strtotime($sendTime)));
        }elseif($frequency == 'CUSTOM'){
          $sendTime = date('Y-m-d H:i:s', strtotime('+1 day', strtotime($sendTime)));
        }

        logMessage('INFO', 'Send time advanced to next occurrence', [
            'newSendTime' => $sendTime,
            'frequency' => $frequency
        ]);
      }else{
        $sendTime = date('Y-m-d').date(' H:i:s', strtotime($sendTime));

        logMessage('SUCCESS', 'Content ready - proceeding with send', [
            'sendTime' => $sendTime
        ]);
      }
      echo "Final Send Time: ".$sendTime."\n";

      if($campaignID != null){
        // echo "Update Campaign\n";
        logMessage('INFO', 'Calling updateCampaign() for existing campaign', [
            'campaignID' => $campaignID,
            'skipDate' => $skipDate,
            'segmentID' => substr($segmentID, 0, 8) . '...',
            'lastSendDate' => $lastSendDate
        ]);

        updateCampaign($id,$campaignID,$subjectType,$newsletterID,$newsletterName,$sendTime,$segmentID,$emailTemplate,$pinTemplateName,$newsletterSubject,$firstHeadline,$lastHeadline,$sendFrequency,$endOn,$endDate,$segmentName,$templateName,$category,$newsletterType,$newsletterDisplayName,$preHeader,$feedURL,$customSubject,$manualNewsletterID,$skipDate,$lastSendDate);

        logMessage('SUCCESS', 'Campaign updated successfully');
      }else{
        logMessage('INFO', 'Calling createCampaign() for new campaign', [
            'skipDate' => $skipDate,
            'segmentID' => substr($segmentID, 0, 8) . '...',
            'lastSendDate' => $lastSendDate
        ]);

        createCampaign($id,$subjectType,$newsletterID,$newsletterName,$sendTime,$segmentID,$emailTemplate,$pinTemplateName,$newsletterSubject,$firstHeadline,$lastHeadline,$sendFrequency,$endOn,$endDate,$segmentName,$templateName,$category,$newsletterType,$newsletterDisplayName,$preHeader,$feedURL,$customSubject,$manualNewsletterID,$skipDate,$lastSendDate);

        logMessage('SUCCESS', 'Campaign created successfully');
      }

      logMessage('INFO', 'Finished processing newsletter', [
          'name' => $newsletterDisplayName
      ]);
    }else{
      logMessage('INFO', 'Not in send window - skipping for now', [
          'reason' => !$frequencyMatch ? 'frequency mismatch' : (!$endDateOk ? 'past end date' : 'outside time window')
      ]);

      // Special handling for CUSTOM frequency - must update campaign to next valid day
      // This prevents Pinpoint from sending on days not in the customFrequency array
      if($frequency == 'CUSTOM'){
        $desired_days = $customFrequency;
        $effectiveDate = date('Y-m-d');
        $current_day = strtoupper(date('l'));
        $next_date = next_day_of_week($current_day, $desired_days, $effectiveDate);

        logMessage('DEBUG', 'CUSTOM frequency - calculating next valid date', [
            'current_day' => $current_day,
            'desired_days' => $desired_days,
            'next_date' => $next_date
        ]);

        if($skipDate){
          logMessage('DEBUG', 'CUSTOM frequency with skipDate - advancing past next date');
          $sendTime = date('c', strtotime($next_date.'T'.date('H:i:s',strtotime($sendTime))));
          $sendTime = date('Y-m-d H:i:s', strtotime($sendTime) + 86400);
        }else if(in_array(strtoupper(date('l')),$customFrequency) && date('H:i:s') > date('H:i:s', strtotime($sendTime))){
          // Today is a valid day but send time has passed - calculate from tomorrow
          $current_day = strtoupper(date('l',strtotime('+1 day')));
          $effectiveDate = date('Y-m-d', strtotime("+1 day"));
          $next_date = next_day_of_week($current_day, $desired_days, $effectiveDate);
          $sendTime = date('c', strtotime($next_date.'T'.date('H:i:s',strtotime($sendTime))));
        }else{
          // Not a valid day or before send time
          $sendTime = date('c', strtotime($next_date.'T'.date('H:i:s',strtotime($sendTime))));
        }

        logMessage('DEBUG', 'CUSTOM frequency - computed sendTime', [
            'sendTime' => $sendTime
        ]);

        // Check if we're now in the time window for the calculated send time
        if(date('H:i:s') >= date('H:i:s', strtotime($sendTime) - 600) && date('H:i:s') <= date('H:i:s', strtotime($sendTime) - 300)){
          logMessage('INFO', 'CUSTOM frequency - in time window, updating campaign', [
              'sendTime' => $sendTime
          ]);

          if($campaignID != null){
            updateCampaign($id,$campaignID,$subjectType,$newsletterID,$newsletterName,$sendTime,$segmentID,$emailTemplate,$pinTemplateName,$newsletterSubject,$firstHeadline,$lastHeadline,$sendFrequency,$endOn,$endDate,$segmentName,$templateName,$category,$newsletterType,$newsletterDisplayName,$preHeader,$feedURL,$customSubject,$manualNewsletterID,false,$lastSendDate);
          }else{
            createCampaign($id,$subjectType,$newsletterID,$newsletterName,$sendTime,$segmentID,$emailTemplate,$pinTemplateName,$newsletterSubject,$firstHeadline,$lastHeadline,$sendFrequency,$endOn,$endDate,$segmentName,$templateName,$category,$newsletterType,$newsletterDisplayName,$preHeader,$feedURL,$customSubject,$manualNewsletterID,false,$lastSendDate);
          }
        }
      }
    }

}

ftruncate($lock_file, 0);
flock($lock_file, LOCK_UN);


