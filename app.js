require('dotenv').config();
const Parser = require('rss-parser');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cron = require('node-cron');
const express = require('express');
const async = require('async');
const NodeCache = require('node-cache');
const winston = require('winston');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

const app = express();
const parser = new Parser();
const axiosInstance = axios.create({
  headers: {
    'User-Agent':
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  },
});
const cache = new NodeCache({ stdTTL: 300 });
const port = config.port;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const discordNotificationsEnabled = config.discordNotificationsEnabled;
const maxRetries = config.maxRetries;
const feedUrls = process.env.FEED_URLS ? process.env.FEED_URLS.split(',') : [];

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configure logger without file transport
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
      timezone: 'Asia/Manila',
    }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

app.set('trust proxy', 1);
app.use(express.json());

// Configure axios-retry
axiosRetry(axiosInstance, {
  retries: maxRetries,
  retryDelay: (retryCount) => {
    return retryCount * config.retryDelay;
  },
  retryCondition: (error) => {
    return (
      axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      (error.response && error.response.status >= 500)
    );
  },
  onRetry: (retryCount, error) => {
    logger.warn(`Retry attempt: ${retryCount}. Error: ${error.message}`);
  },
});

// Divide the feed URLs into batches
const batchSize = Math.ceil(feedUrls.length / 3);
const batch1 = feedUrls.slice(0, batchSize);
const batch2 = feedUrls.slice(batchSize, batchSize * 2);
const batch3 = feedUrls.slice(batchSize * 2);

// Function to check feed updates for a batch of URLs
async function checkFeedUpdates(batch) {
  try {
    await async.eachLimit(batch, 5, async (feedUrl) => {
      try {
        const cachedFeed = cache.get(feedUrl);
        if (cachedFeed) {
          logger.info(`Fetching feed from cache: ${feedUrl}`);
          await processFeedItems(cachedFeed, feedUrl);
        } else {
          logger.info(`Fetching feed from URL: ${feedUrl}`);
          const feed = await parser.parseURL(feedUrl);
          cache.set(feedUrl, feed);
          await processFeedItems(feed, feedUrl);
        }
      } catch (error) {
        logger.error(`Error fetching feed from ${feedUrl}: ${error.message}`);
        await sendDiscordErrorNotification(
          `Error fetching feed from ${feedUrl}: ${error.message}`,
          error.stack
        );
      }
    });
  } catch (error) {
    logger.error(`Unhandled error in checkFeedUpdates: ${error.message}`);
    throw error;
  }
}

// Function to process feed items
async function processFeedItems(feed, feedUrl) {
  const startTime = Date.now();
  let processedItems = 0;

  try {
    // Retrieve the last processed item's date from Supabase
    const { data: lastProcessedItem, error } = await supabase
      .from('last_processed_items')
      .select('last_item_date')
      .eq('feed_url', feedUrl)
      .maybeSingle();

    if (error) {
      logger.error(`Error retrieving last processed item for ${feedUrl}: ${error.message}`);
      return;
    }

    const lastItemDate = lastProcessedItem ? new Date(lastProcessedItem.last_item_date) : null;

    const itemsPerPage = 10;
    let currentPage = 1;
    let totalPages = Math.ceil(feed.items.length / itemsPerPage);

    const newItems = [];

    while (currentPage <= totalPages) {
      const startIndex = (currentPage - 1) * itemsPerPage;
      const endIndex = startIndex + itemsPerPage;
      const pageItems = feed.items.slice(startIndex, endIndex);

      for (const item of pageItems) {
        const itemDate = new Date(item.pubDate);
        if (!lastItemDate || itemDate > lastItemDate) {
          newItems.push(item);
          processedItems++;
        }
      }

      currentPage++;
    }

    if (newItems.length > 0) {
      await sendDiscordNotification(newItems);

      // Update the last processed item's date in Supabase
      const { error: updateError } = await supabase
        .from('last_processed_items')
        .upsert({ feed_url: feedUrl, last_item_date: newItems[0].pubDate })
        .select();

      if (updateError) {
        logger.error(`Error updating last processed item for ${feedUrl}: ${updateError.message}`);
      }
    }
  } catch (error) {
    logger.error(`Error processing feed items for ${feedUrl}: ${error.message}`);
  }

  const endTime = Date.now();
  const timeTaken = endTime - startTime;
  logger.info(`Processed ${processedItems} feed items for ${feedUrl} in ${timeTaken}ms`);
}

// Queue for handling Discord notifications
const notificationQueue = async.queue(async (task, callback) => {
  const { items, isError, errorStack } = task;

  if (isError) {
    const message = `**RSS Feed Error**\n${items}\n\`\`\`${errorStack}\`\`\``;
    await sendNotification(message);
  } else {
    const itemMessages = items.map((item) => `**New RSS Feed Item**\nTitle: ${item.title}\nLink: ${item.link}\nPublished Date: ${item.pubDate}`);
    const message = itemMessages.join('\n\n');
    await sendNotification(message);
  }

  callback();

  async function sendNotification(message) {
    const maxRetries = 3; // Maximum number of retries
    let retries = 0;

    async function attempt() {
      try {
        const response = await axiosInstance.post(discordWebhookUrl, {
          content: message,
        });

        const rateLimitRemaining = parseInt(
          response.headers['x-ratelimit-remaining']
        );
        const rateLimitReset = parseInt(response.headers['x-ratelimit-reset']);

        if (rateLimitRemaining === 0) {
          const resetTime = rateLimitReset * 1000; // Convert to milliseconds
          const delay = resetTime - Date.now();
          logger.warn(`Rate limit exceeded. Waiting for ${delay}ms before retrying.`);
          setTimeout(attempt, delay);
        } else {
          logger.info('Notification sent to Discord');
        }
      } catch (error) {
        if (error.response && error.response.status === 429) {
          if (retries < maxRetries) {
            retries++;
            const delay = Math.pow(2, retries) * 1000; // Exponential backoff
            logger.warn(`Rate limit exceeded. Retrying in ${delay}ms.`);
            setTimeout(attempt, delay);
          } else {
            logger.error('Max retries reached. Notification failed.');
          }
        } else {
          logger.error(`Error sending notification to Discord: ${error.message}`);
        }
      }
    }

    attempt();
  }
}, 1);

// Function to send Discord notifications for new feed items
async function sendDiscordNotification(items) {
  if (discordNotificationsEnabled) {
    try {
      notificationQueue.push({ items, isError: false });
    } catch (error) {
      logger.error(`Error sending notification to Discord: ${error.message}`);
    }
  }
}

// Function to send Discord error notifications
async function sendDiscordErrorNotification(errorMessage, errorStack) {
  if (discordNotificationsEnabled) {
    try {
      notificationQueue.push({ items: errorMessage, isError: true, errorStack });
    } catch (error) {
      logger.error(
        `Error sending error notification to Discord: ${error.message}`
      );
    }
  }
}

// Route for health check
app.get('/', (_req, res) => {
  res.send('RSS Feed Reader is running!');
});

// Error handling middleware
app.use((err, _req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).send('Internal Server Error');
});

// Start the server
app.listen(port, () => {
  logger.info(`RSS Feed Reader is listening on port ${port}`);
  checkFeedUpdates(batch1); // Call checkFeedUpdates() for batch1 on app startup
  checkFeedUpdates(batch2); // Call checkFeedUpdates() for batch2 on app startup
  checkFeedUpdates(batch3); // Call checkFeedUpdates() for batch3 on app startup
});

// Schedule cron jobs for each batch of feed URLs
cron.schedule('*/5 * * * *', () => checkFeedUpdates(batch1));
cron.schedule('*/10 * * * *', () => checkFeedUpdates(batch2));
cron.schedule('*/15 * * * *', () => checkFeedUpdates(batch3));