const axios = require('axios');
const Parser = require('rss-parser');
const Redis = require('@upstash/redis').Redis;
const { Octokit } = require('@octokit/rest');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
require('dotenv').config();

const parser = new Parser();
const octokit = new Octokit({
  auth: process.env.GITHUB_ACCESS_TOKEN,
});

// Create a Redis instance
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Function to format the date and time in GMT+8 Manila format
function formatDateTime(dateString) {
  const date = new Date(dateString);
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Manila',
    timeZoneName: 'short',
  };
  const formattedDate = date.toLocaleDateString('en-US', options);
  const [datePart, timePart] = formattedDate.split(', ');
  return `${datePart},${timePart}`;
}

// Function to sanitize a string for CSV format
function sanitizeCSV(value) {
  if (typeof value !== 'string') {
    return value;
  }

  // Remove newline characters
  value = value.replace(/[\n\r]/g, '');

  // Replace double quotes with two double quotes
  value = value.replace(/"/g, '""');

  // Replace U+2019 "'" with ASCII character U+0027 "'"
  value = value.replace(/'/g, "'");

  // Remove any other problematic characters
  value = value.replace(/[,;\t]/g, '');

  // Remove HTML tags
  value = value.replace(/<[^>]*>/g, '');

  return value;
}

// Function to remove tracking parameters from URL
async function removeTrackingParams(url) {
  try {
    // Remove UTM parameters (Google Analytics)
    url = url.replace(/(\?|&)(utm_\w+=[^&]*)/g, '');

    // Remove Facebook click identifier
    url = url.replace(/(\?|&)fbclid=[^&]*/g, '');

    // Remove Twitter click identifier
    url = url.replace(/(\?|&)t=[^&]*/g, '');

    // Remove LinkedIn click identifier
    url = url.replace(/(\?|&)lipi=[^&]*/g, '');

    // Remove Instagram click identifier
    url = url.replace(/(\?|&)igshid=[^&]*/g, '');

    // Remove Pinterest click identifier
    url = url.replace(/(\?|&)pin_\w+=[^&]*/g, '');

    // Remove Reddit click identifier
    url = url.replace(/(\?|&)ref=\w+/g, '');

    // Remove TikTok click identifier
    url = url.replace(/(\?|&)_t=[^&]*/g, '');

    // Remove Snapchat click identifier
    url = url.replace(/(\?|&)sc_[^&]*/g, '');

    // Remove YouTube click identifier
    url = url.replace(/(\?|&)feature=[^&]*/g, '');

    // Remove trailing question mark or ampersand if present
    url = url.replace(/[?&]$/, '');
  } catch (error) {
    console.error('Error removing tracking parameters from URL:', error);
    // Send an error notification to Discord webhook
    await sendErrorNotification(process.env.WEBHOOK_URL, `Error removing tracking parameters from URL: ${error.message}`);
  }

  return url;
}

// Function to send a notification to the Discord webhook with rate limit handling
async function sendDiscordNotification(feed) {
  const { title, link, isoDate } = feed;

  const embedData = {
    title: title,
    url: link,
    timestamp: new Date().toISOString(),
    fields: [
      {
        name: 'Published Date',
        value: formatDateTime(isoDate),
      },
      {
        name: 'URL',
        value: link,
      },
    ],
  };

  const maxRetries = 3;
  let retries = 0;
  let globalRateLimited = false;

  while (retries < maxRetries) {
    try {
      await axios.post(process.env.WEBHOOK_URL, {
        embeds: [embedData],
      });
      console.log(`Notification sent for: ${title}`);
      break;
    } catch (error) {
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.data.retry_after * 1000;
        const isGlobal = error.response.data.global;

        if (isGlobal) {
          console.log('Global rate limit hit. Pausing all requests.');
          globalRateLimited = true;
          await new Promise((resolve) => setTimeout(resolve, retryAfter));
        } else {
          console.log(`Rate limit hit for notification: ${title}. Retrying after ${retryAfter}ms.`);
          await new Promise((resolve) => setTimeout(resolve, retryAfter));
        }
      } else {
        console.error('Error sending Discord notification:', error);
        await sendErrorNotification(process.env.WEBHOOK_URL, `Error sending Discord notification: ${error.message}`);
        break;
      }
    }

    retries++;
  }

  if (retries === maxRetries) {
    console.error(`Failed to send notification after ${maxRetries} retries: ${title}`);
    await sendErrorNotification(process.env.WEBHOOK_URL, `Failed to send notification after ${maxRetries} retries: ${title}`);
  }

  if (globalRateLimited) {
    console.log('Global rate limit resolved. Resuming requests.');
  }
}

// Function to send an error notification to a separate Discord webhook
async function sendErrorNotification(feedUrl, errorMessage) {
  const embedData = {
    title: 'Error Checking Feed',
    description: `An error occurred while checking the feed: ${feedUrl}`,
    color: 16711680, // Red color
    fields: [
      {
        name: 'Error Message',
        value: errorMessage,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  try {
    await axios.post(process.env.ERROR_WEBHOOK_URL, {
      embeds: [embedData],
    }, {
      timeout: 5000, // Set a timeout of 5 seconds
    });
    console.log(`Error notification sent for feed: ${feedUrl}`);
  } catch (error) {
    console.error('Error sending error notification:', error);
  }
}

// Simple queue implementation for sending notifications with a delay
const notificationQueue = [];
let isProcessingQueue = false;

async function processNotificationQueue() {
  if (isProcessingQueue || notificationQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (notificationQueue.length > 0) {
    const notification = notificationQueue.shift();
    await sendDiscordNotification(notification);
    await new Promise((resolve) => setTimeout(resolve, process.env.NOTIFICATION_DELAY));
  }

  isProcessingQueue = false;
}

// Function to commit changes to a GitHub repository
async function commitChangesToRepository(owner, repo, filePath, content, commitMessage) {
  try {
    // Check if the repository exists
    try {
      await octokit.repos.get({
        owner,
        repo,
      });
    } catch (error) {
      if (error.status === 404) {
        console.error(`Repository ${owner}/${repo} not found. Please create the repository on GitHub.`);
        await sendErrorNotification(process.env.WEBHOOK_URL, `Repository ${owner}/${repo} not found. Please create the repository on GitHub.`);
        return;
      }
      throw error;
    }

    let latestCommitSha = null;

    try {
      const { data: { sha } } = await octokit.repos.getCommit({
        owner,
        repo,
        ref: 'main',
      });
      latestCommitSha = sha;
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    const { data: { sha: blobSha } } = await octokit.git.createBlob({
      owner,
      repo,
      content,
      encoding: 'utf-8',
    });

    const tree = [
      {
        path: filePath,
        mode: '100644',
        type: 'blob',
        sha: blobSha,
      },
    ];

    if (latestCommitSha) {
      const { data: { sha: treeSha } } = await octokit.git.createTree({
        owner,
        repo,
        base_tree: latestCommitSha,
        tree,
      });

      const { data: { sha: newCommitSha } } = await octokit.git.createCommit({
        owner,
        repo,
        message: commitMessage,
        tree: treeSha,
        parents: [latestCommitSha],
      });

      latestCommitSha = newCommitSha;
    } else {
      const { data: { sha: newCommitSha } } = await octokit.git.createCommit({
        owner,
        repo,
        message: commitMessage,
        tree,
      });

      latestCommitSha = newCommitSha;
    }

    await octokit.git.updateRef({
      owner,
      repo,
      ref: 'heads/main',
      sha: latestCommitSha,
    });

    console.log('Changes committed successfully!');
  } catch (error) {
    console.error('Error committing changes:', error);
    await sendErrorNotification(process.env.WEBHOOK_URL, `Error committing changes: ${error.message}`);
  }
}

// Function to check for new feeds and commit changes to GitHub repository
async function checkFeeds() {
  const feeds = process.env.FEEDS.split(',').map((url) => ({ url }));
  const githubRepo = {
    owner: process.env.GITHUB_REPO_OWNER,
    repo: process.env.GITHUB_REPO_NAME,
    filePath: process.env.GITHUB_REPO_FILE_PATH,
  };

  for (const feed of feeds) {
    try {
      const { url } = feed;
      const lastCheckedTime = await redis.get(url) || 0;

      const parsedFeed = await retryRequest(() => parser.parseURL(url));
      const newItems = parsedFeed.items.filter(
        (item) => new Date(item.isoDate).getTime() > lastCheckedTime
      );

      if (newItems.length > 0) {
        console.log(`Found ${newItems.length} new item(s) in feed: ${url}`);

        // Add new items to the notification queue
        notificationQueue.push(...newItems);

        // Update the last checked time for the feed in Redis
        await redis.set(url, new Date(parsedFeed.lastBuildDate).getTime());

        // Commit new items to the GitHub repository
        try {
          const { data: fileContent } = await octokit.repos.getContent({
            owner: githubRepo.owner,
            repo: githubRepo.repo,
            path: githubRepo.filePath,
          });

          const decodedContent = Buffer.from(fileContent.content, 'base64').toString('utf-8');
          const records = parse(decodedContent, { columns: true });

          for (const item of newItems) {
            const title = item.title || 'No title available';
            const link = item.link || 'No link available';
            const isoDate = item.isoDate || new Date().toISOString();

            const [date, time] = formatDateTime(isoDate).split(',');
            const sanitizedTitle = sanitizeCSV(title);
            const sanitizedLink = await removeTrackingParams(sanitizeCSV(link));

            records.push({
              Date: date,
              Time: time,
              Title: sanitizedTitle,
              URL: sanitizedLink,
            });
          }

          // Sort the records based on the 'Date' and 'Time' columns in descending order
          records.sort((a, b) => {
            try {
              const dateA = new Date(a.Date);
              const dateB = new Date(b.Date);

              // Compare dates, and if equal, compare times
              if (dateA.getTime() === dateB.getTime()) {
                return b.Time.localeCompare(a.Time);
              }
              return dateB.getTime() - dateA.getTime(); // Sort in descending order
            } catch (error) {
              console.error('Error parsing date:', error);
              // Assign a default value to the comparison
              return 0;
            }
          });

          const updatedContent = stringify(records, { header: true });

          await commitChangesToRepository(
            githubRepo.owner,
            githubRepo.repo,
            githubRepo.filePath,
            updatedContent,
            'Update CSV file with new items'
          );
        } catch (error) {
          if (error.status === 404) {
            // CSV file doesn't exist, create a new file with headers
            const headers = ['Date', 'Time', 'Title', 'URL'];
            const records = await Promise.all(
              newItems.map(async (item) => {
                const [date, time] = formatDateTime(item.isoDate || new Date().toISOString()).split(',');
                return {
                  Date: date,
                  Time: time,
                  Title: sanitizeCSV(item.title || 'No title available'),
                  URL: await removeTrackingParams(sanitizeCSV(item.link || 'No link available')),
                };
              })
            );

            const content = stringify(records, { header: true, columns: headers });

            await commitChangesToRepository(
              githubRepo.owner,
              githubRepo.repo,
              githubRepo.filePath,
              content,
              'Create CSV file with new items'
            );
          } else {
            console.error('Error retrieving or creating CSV file:', error);
            await sendErrorNotification(process.env.WEBHOOK_URL, `Error retrieving or creating CSV file: ${error.message}`);
          }
        }
      } else {
        console.log(`No new items found in feed: ${url}`);
      }
    } catch (error) {
      console.error(`Error checking feed ${feed.url}:`, error);
      await sendErrorNotification(feed.url, error.message);
    }
  }

  // Process the notification queue
  await processNotificationQueue();
}

// Function to retry a request with exponential backoff
async function retryRequest(requestFn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await requestFn();
    } catch (error) {
      if (i === retries - 1) {
        console.error('Request failed after retries:', error);
        await sendErrorNotification(process.env.WEBHOOK_URL, `Request failed after retries: ${error.message}`);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

// Start the feed checker
async function startFeedChecker() {
  console.log('Starting RSS Feed Notifier...');

  try {
    // Check the feeds immediately when the script starts
    await checkFeeds();

    // Set up an interval to check the feeds every 5 minutes (300000 milliseconds)
    setInterval(checkFeeds, process.env.CHECK_INTERVAL);
  } catch (error) {
    console.error('Unhandled error in startFeedChecker:', error);
    await sendErrorNotification(process.env.WEBHOOK_URL, `Unhandled error in startFeedChecker: ${error.message}`);
  }
}

startFeedChecker();