import 'dotenv/config';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Octokit } from '@octokit/rest';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import Parser from 'rss-parser';
import { Redis } from '@upstash/redis';

// Utility functions
async function saveToJSONFile(key, value) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.join(__dirname, 'data.json');

  try {
    let data = {};

    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      data = JSON.parse(fileContent);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    data[key] = value;

    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving data to JSON file:', error);
    await notificationService.sendErrorNotification(process.env.WEBHOOK_URL, `Error saving data to JSON file: ${error.message}`);
  }
}

async function getFromJSONFile(key) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.join(__dirname, 'data.json');

  try {
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(fileContent);
    return data[key] || 0;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 0;
    }
    console.error('Error retrieving data from JSON file:', error);
    await notificationService.sendErrorNotification(process.env.WEBHOOK_URL, `Error retrieving data from JSON file: ${error.message}`);
    return 0;
  }
}

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
  };
  const formattedDate = date.toLocaleString('en-US', options);
  const [datePart, timePart] = formattedDate.split(', ');
  return `${datePart}, ${timePart} GMT+8`;
}

function sanitizeCSV(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value
    .replace(/[\n\r]/g, '')
    .replace(/"/g, '""')
    .replace(/'/g, "'")
    .replace(/[,;\t]/g, '')
    .replace(/<[^>]*>/g, '');
}

async function removeTrackingParams(url) {
  try {
    return url
      .replace(/(\?|&)(utm_\w+=[^&]*)/g, '')
      .replace(/(\?|&)fbclid=[^&]*/g, '')
      .replace(/(\?|&)t=[^&]*/g, '')
      .replace(/(\?|&)lipi=[^&]*/g, '')
      .replace(/(\?|&)igshid=[^&]*/g, '')
      .replace(/(\?|&)pin_\w+=[^&]*/g, '')
      .replace(/(\?|&)ref=\w+/g, '')
      .replace(/(\?|&)_t=[^&]*/g, '')
      .replace(/(\?|&)sc_[^&]*/g, '')
      .replace(/(\?|&)feature=[^&]*/g, '')
      .replace(/[?&]$/, '');
  } catch (error) {
    console.error('Error removing tracking parameters from URL:', error);
    await notificationService.sendErrorNotification(process.env.WEBHOOK_URL, `Error removing tracking parameters from URL: ${error.message}`);
    return url;
  }
}

// Configuration and setup
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  },
  requestOptions: {
    rejectUnauthorized: false
  }
});
const octokit = new Octokit({
  auth: process.env.GITHUB_ACCESS_TOKEN,
});

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  })
  : null;

// Notification service classes
class NotificationService {
  /**
   * Sends a notification for a feed item.
   * @param {object} feed - The feed item to send a notification for.
   * @throws {Error} Not implemented error.
   */
  async sendNotification(feed) {
    throw new Error('Not implemented');
  }

  /**
   * Sends an error notification for a feed.
   * @param {string} feedUrl - The URL of the feed that encountered an error.
   * @param {string} errorMessage - The error message associated with the feed.
   * @throws {Error} Not implemented error.
   */
  async sendErrorNotification(feedUrl, errorMessage) {
    throw new Error('Not implemented');
  }
}

class DiscordNotificationService extends NotificationService {
  async sendNotification(feed) {
    if (process.env.NOTIFICATIONS_ENABLED !== 'true') {
      console.log('Notifications are disabled. Skipping notification.');
      return;
    }
    const { title, link, isoDate } = feed;

    const embedData = {
      title: `📰 ${title}`,
      url: link,
      timestamp: new Date().toISOString(),
      fields: [
        {
          name: '📅 Published Date',
          value: formatDateTime(isoDate),
        },
        {
          name: '🔗 URL',
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
          content: '🚨 New feed item detected! 🚨',
          embeds: [embedData],
        });
        console.log(`✅ Notification sent for: ${title}`);
        break;
      } catch (error) {
        if (error.response && error.response.status === 429) {
          const retryAfter = error.response.data.retry_after * 1000;
          const isGlobal = error.response.data.global;

          if (isGlobal) {
            console.log('⏳ Global rate limit hit. Pausing all requests.');
            globalRateLimited = true;
            await new Promise((resolve) => setTimeout(resolve, retryAfter));
          } else {
            console.log(`⏳ Rate limit hit for notification: ${title}. Retrying after ${retryAfter}ms.`);
            await new Promise((resolve) => setTimeout(resolve, retryAfter));
          }
        } else {
          console.error('❌ Error sending Discord notification:', error);
          await this.sendErrorNotification(process.env.WEBHOOK_URL, `❌ Error sending Discord notification: ${error.message}`);
          break;
        }
      }

      retries++;
    }

    if (retries === maxRetries) {
      console.error(`❌ Failed to send notification after ${maxRetries} retries: ${title}`);
      await this.sendErrorNotification(process.env.WEBHOOK_URL, `❌ Failed to send notification after ${maxRetries} retries: ${title}`);
    }

    if (globalRateLimited) {
      console.log('✅ Global rate limit resolved. Resuming requests.');
    }
  }

  async sendErrorNotification(feedUrl, errorMessage) {
    if (process.env.NOTIFICATIONS_ENABLED !== 'true') {
      console.log('Notifications are disabled. Skipping error notification.');
      return;
    }
    const embedData = {
      title: '🚨 Error Checking Feed',
      description: `❌ An error occurred while checking the feed: ${feedUrl}`,
      color: 16711680,
      fields: [
        {
          name: '❌ Error Message',
          value: errorMessage,
        },
      ],
      timestamp: new Date().toISOString(),
    };

    try {
      await axios.post(process.env.ERROR_WEBHOOK_URL, {
        content: '🚨 Feed Checker Error! 🚨',
        embeds: [embedData],
      }, {
        timeout: 5000,
      });
      console.log(`✅ Error notification sent for feed: ${feedUrl}`);
    } catch (error) {
      console.error('❌ Error sending error notification:', error);
    }
  }
}

class SlackNotificationService extends NotificationService {
  async sendNotification(feed) {
    if (process.env.NOTIFICATIONS_ENABLED !== 'true') {
      console.log('Notifications are disabled. Skipping notification.');
      return;
    }
    const { title, link, isoDate } = feed;

    const message = {
      text: `New feed item: ${title}`,
      attachments: [
        {
          title,
          title_link: link,
          fields: [
            {
              title: 'Published Date',
              value: formatDateTime(isoDate),
              short: true,
            },
            {
              title: 'URL',
              value: link,
              short: false,
            },
          ],
          ts: Math.floor(new Date().getTime() / 1000),
        },
      ],
    };

    try {
      await axios.post(process.env.SLACK_WEBHOOK_URL, message);
      console.log(`Notification sent for: ${title}`);
    } catch (error) {
      console.error('Error sending Slack notification:', error);
      await this.sendErrorNotification(process.env.SLACK_WEBHOOK_URL, `Error sending Slack notification: ${error.message}`);
    }
  }

  async sendErrorNotification(feedUrl, errorMessage) {
    if (process.env.NOTIFICATIONS_ENABLED !== 'true') {
      console.log('Notifications are disabled. Skipping error notification.');
      return;
    }
    const message = {
      text: `Error Checking Feed: ${feedUrl}`,
      attachments: [
        {
          color: 'danger',
          fields: [
            {
              title: 'Error Message',
              value: errorMessage,
              short: false,
            },
          ],
          ts: Math.floor(new Date().getTime() / 1000),
        },
      ],
    };

    try {
      await axios.post(process.env.SLACK_ERROR_WEBHOOK_URL, message);
      console.log(`Error notification sent for feed: ${feedUrl}`);
    } catch (error) {
      console.error('Error sending Slack error notification:', error);
    }
  }
}

class TeamsNotificationService extends NotificationService {
  async sendNotification(feed) {
    if (process.env.NOTIFICATIONS_ENABLED !== 'true') {
      console.log('Notifications are disabled. Skipping notification.');
      return;
    }
    const { title, link, isoDate } = feed;

    const card = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      themeColor: '0076D7',
      summary: `New feed item: ${title}`,
      sections: [
        {
          activityTitle: title,
          activitySubtitle: formatDateTime(isoDate),
          activityImage: '',
          facts: [
            {
              name: 'URL',
              value: link,
            },
          ],
          markdown: true,
        },
      ],
      potentialAction: [
        {
          '@type': 'OpenUri',
          name: 'View in browser',
          targets: [
            {
              os: 'default',
              uri: link,
            },
          ],
        },
      ],
    };

    try {
      await axios.post(process.env.TEAMS_WEBHOOK_URL, card);
      console.log(`Notification sent for: ${title}`);
    } catch (error) {
      console.error('Error sending Teams notification:', error);
      await this.sendErrorNotification(process.env.TEAMS_WEBHOOK_URL, `Error sending Teams notification: ${error.message}`);
    }
  }

  async sendErrorNotification(feedUrl, errorMessage) {
    if (process.env.NOTIFICATIONS_ENABLED !== 'true') {
      console.log('Notifications are disabled. Skipping error notification.');
      return;
    }
    const card = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      themeColor: 'FF0000',
      summary: `Error Checking Feed: ${feedUrl}`,
      sections: [
        {
          activityTitle: 'Error Checking Feed',
          activitySubtitle: feedUrl,
          activityImage: '',
          facts: [
            {
              name: 'Error Message',
              value: errorMessage,
            },
          ],
          markdown: true,
        },
      ],
    };

    try {
      await axios.post(process.env.TEAMS_ERROR_WEBHOOK_URL, card);
      console.log(`Error notification sent for feed: ${feedUrl}`);
    } catch (error) {
      console.error('Error sending Teams error notification:', error);
    }
  }
}

// Notification service factory
function createNotificationService(serviceType) {
  switch (serviceType) {
    case 'discord':
      return new DiscordNotificationService();
    case 'slack':
      return new SlackNotificationService();
    case 'teams':
      return new TeamsNotificationService();
    default:
      throw new Error('Invalid notification service type');
  }
}

const notificationService = createNotificationService(process.env.NOTIFICATION_SERVICE);

// Notification queue and processing
const notificationQueue = [];
let isProcessingQueue = false;

async function processNotificationQueue() {
  if (isProcessingQueue || notificationQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (notificationQueue.length > 0) {
    const notification = notificationQueue.shift();
    await notificationService.sendNotification(notification);
    await new Promise((resolve) => setTimeout(resolve, process.env.NOTIFICATION_DELAY));
  }

  isProcessingQueue = false;
}

// GitHub repository functions
async function commitChangesToRepository(owner, repo, filePath, content, commitMessage) {
  try {
    try {
      await octokit.repos.get({
        owner,
        repo,
      });
    } catch (error) {
      if (error.status === 404) {
        console.error(`Repository ${owner}/${repo} not found. Please create the repository on GitHub.`);
        await notificationService.sendErrorNotification(process.env.WEBHOOK_URL, `Repository ${owner}/${repo} not found. Please create the repository on GitHub.`);
        return;
      }
      throw error;
    }

    let latestCommitSha = null;

    try {
      const { data: { object: { sha } } } = await octokit.git.getRef({
        owner,
        repo,
        ref: 'heads/main',
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
      force: true,
    });

    console.log('Changes committed successfully!');
  } catch (error) {
    console.error('Error committing changes:', error);
    await notificationService.sendErrorNotification(process.env.WEBHOOK_URL, `Error committing changes: ${error.message}`);
  }
}

async function processNewItems(newItems, githubRepo) {
  const maxQueueSize = parseInt(process.env.MAX_QUEUE_SIZE, 10) || 50;
  
  if (notificationQueue.length + newItems.length > maxQueueSize) {
    console.warn('Notification queue size exceeded. Discarding oldest notifications.');
    notificationQueue.splice(0, newItems.length); // Remove oldest notifications
  }
  notificationQueue.push(...newItems);
  await commitNewItemsToRepository(newItems, githubRepo);
}

async function commitNewItemsToRepository(newItems, githubRepo) {
  try {
    let records = [];

    try {
      const { data: fileContent } = await octokit.repos.getContent({
        owner: githubRepo.owner,
        repo: githubRepo.repo,
        path: githubRepo.filePath,
      });

      const decodedContent = Buffer.from(fileContent.content, 'base64').toString('utf-8');
      records = parse(decodedContent, { columns: true });
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    const updatedRecords = await Promise.all(
      newItems.map(async (item) => {
        const title = item.title || 'No title available';
        const link = item.link || 'No link available';
        const isoDate = item.isoDate || new Date().toISOString();

        const [date, time] = formatDateTime(isoDate).split(',');
        const sanitizedTitle = sanitizeCSV(title);
        const sanitizedLink = await removeTrackingParams(sanitizeCSV(link));

        return {
          Date: date,
          Time: time,
          Title: sanitizedTitle,
          URL: sanitizedLink,
        };
      })
    );

    records.push(...updatedRecords);

    records.sort((a, b) => {
      const dateA = new Date(`${a.Date} ${a.Time}`);
      const dateB = new Date(`${b.Date} ${b.Time}`);

      return dateB.getTime() - dateA.getTime();
    });

    const updatedContent = stringify(records, { header: true });

    await commitChangesToRepository(
      githubRepo.owner,
      githubRepo.repo,
      githubRepo.filePath,
      updatedContent,
      `Add ${newItems.length} new RSS feed item(s) to ${githubRepo.filePath}`
    );
  } catch (error) {
    if (error.status === 404) {
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
        `Create ${githubRepo.filePath} with ${newItems.length} new RSS feed item(s)`
      );
    } else {
      console.error('Error retrieving or creating CSV file:', error);
      await notificationService.sendErrorNotification(process.env.WEBHOOK_URL, `Error retrieving or creating CSV file: ${error.message}`);
    }
  }
}

// Feed checking functions
async function checkFeed(feed) {
  try {
    const { url } = feed;
    const lastCheckedTime = redis
      ? await redis.get(url) || 0
      : await getFromJSONFile(url);

    const parsedFeed = await retryRequest(() => parser.parseURL(url));
    const newItems = parsedFeed.items.filter(
      (item) => new Date(item.pubDate).getTime() > lastCheckedTime
    );

    if (newItems.length > 0) {
      console.log(`Found ${newItems.length} new item(s) in feed: ${url}`);
      return newItems;
    } else {
      console.log(`No new items found in feed: ${url}`);
      return [];
    }
  } catch (error) {
    console.error(`Error checking feed ${feed.url}:`, error);
    await notificationService.sendErrorNotification(feed.url, error.message);
    return [];
  }
}

async function checkFeeds() {
  const feeds = process.env.FEEDS.split(',').map((url) => ({ url }));
  const githubRepo = {
    owner: process.env.GITHUB_REPO_OWNER,
    repo: process.env.GITHUB_REPO_NAME,
    filePath: process.env.GITHUB_REPO_FILE_PATH,
  };

  const allNewItems = await Promise.all(feeds.map((feed) => checkFeed(feed)));
  const flattenedNewItems = allNewItems.flat();

  if (flattenedNewItems.length > 0) {
    await processNewItems(flattenedNewItems, githubRepo);

    for (const feed of feeds) {
      const { url } = feed;
      const parsedFeed = await retryRequest(() => parser.parseURL(url));
      const lastBuildDate = parsedFeed.lastBuildDate ? new Date(parsedFeed.lastBuildDate).getTime() : Date.now();
      if (redis) {
        await redis.set(url, lastBuildDate);
      } else {
        await saveToJSONFile(url, lastBuildDate);
      }
    }
  }

  await processNotificationQueue();
}

// Retry request function
async function retryRequest(requestFn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await requestFn();
    } catch (error) {
      if (i === retries - 1) {
        console.error('Request failed after retries:', error);
        await notificationService.sendErrorNotification(process.env.WEBHOOK_URL, `Request failed after retries: ${error.message}`);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

// Main function
async function startFeedChecker() {
  console.log('Starting RSS Feed Notifier...');

  try {
    await checkFeeds();
    setInterval(checkFeeds, process.env.CHECK_INTERVAL);
  } catch (error) {
    console.error('Unhandled error in startFeedChecker:', error);
    await notificationService.sendErrorNotification(process.env.WEBHOOK_URL, `Unhandled error in startFeedChecker: ${error.message}`);
  }
}

// Start the RSS Feed Notifier
startFeedChecker();