import fs from 'fs';
import https from 'https';
import axios from 'axios';
import { DateTime } from 'luxon';
import { Octokit } from '@octokit/rest';
import { parse } from 'csv-parse';
import { parseFeed } from 'htmlparser2';
import { stringify } from 'csv-stringify';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import pLimit from 'p-limit';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new DailyRotateFile({
            filename: 'error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '500m',
            maxFiles: '14d',
            level: 'error',
        }),
        new DailyRotateFile({
            filename: 'combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '500m',
            maxFiles: '14d',
        }),
    ]
});

class DiscordNotifier {
    constructor(webhookUrl, errorWebhookUrl) {
        this.webhookUrl = webhookUrl;
        this.errorWebhookUrl = errorWebhookUrl;
    }

    async sendNotification(item) {
        try {
            const formattedDate = this.formatDate(item.pubDate);

            const response = await axios.post(
                this.webhookUrl,
                {
                    content: `New RSS item: ${item.title}\nPublished at: ${formattedDate} (GMT+8)\n${item.link}`,
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            );

            await this.handleRateLimit(response);

            logger.info(`Notification sent for item: ${item.title}`);
        } catch (error) {
            await this.handleError(error, item);
        }
    }

    async sendErrorNotification(message) {
        try {
            const response = await axios.post(
                this.errorWebhookUrl,
                {
                    content: message,
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }
            );

            await this.handleRateLimit(response);

            logger.info(`Error notification sent: ${message}`);
        } catch (error) {
            logger.error('Error sending Discord error notification:', error);
        }
    }

    async handleRateLimit(response) {
        const rateLimitRemaining = parseInt(response.headers['x-ratelimit-remaining']);
        const rateLimitReset = parseInt(response.headers['x-ratelimit-reset']);

        if (rateLimitRemaining === 0) {
            const resetTime = new Date(rateLimitReset * 1000);
            logger.info(`Rate limit exceeded. Waiting until ${resetTime.toLocaleString()} to continue.`);
            await new Promise((resolve) => setTimeout(resolve, rateLimitReset * 1000 - Date.now()));
        }
    }

    async handleError(error, item) {
        if (error.response && error.response.status === 429) {
            const retryAfter = parseInt(error.response.headers['retry-after']);
            logger.warn(`Rate limit exceeded. Retrying after ${retryAfter} seconds.`);
            await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
            await this.sendNotification(item);
        } else {
            logger.error('Error sending Discord notification:', error, 'Item:', item);
        }
    }

    formatDate(pubDate) {
        const manilaTime = pubDate ? DateTime.fromJSDate(new Date(pubDate)).setZone('Asia/Manila') : DateTime.now().setZone('Asia/Manila');
        return manilaTime.toFormat('yyyy-MM-dd HH:mm:ss');
    }
}

class GitHubIntegration {
    constructor(owner, repo, token) {
        this.owner = owner;
        this.repo = repo;
        this.octokit = new Octokit({
            auth: token,
            throttle: {
                onRateLimit: (retryAfter, options) => {
                    logger.warn(`Request quota exhausted for request ${options.method} ${options.url}`);
                    if (options.request.retryCount <= 2) {
                        logger.info(`Retrying after ${retryAfter} seconds!`);
                        return true;
                    }
                },
                onAbuseLimit: (retryAfter, options) => {
                    logger.warn(`Abuse detected for request ${options.method} ${options.url}`);
                },
            },
        });
    }

    async commitUpdates(newItems, dataFile) {
        try {
            const path = dataFile;
            let csvContent = '';
            let sha = undefined;
            try {
                const response = await this.octokit.repos.getContent({
                    owner: this.owner,
                    repo: this.repo,
                    path,
                });
                csvContent = Buffer.from(response.data.content, 'base64').toString();
                sha = response.data.sha;
            } catch (error) {
                if (error.status !== 404) {
                    throw error;
                }
                // File doesn't exist, we'll create it
            }

            const records = await new Promise((resolve, reject) => {
                parse(csvContent, { columns: true }, (err, records) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(records);
                    }
                });
            });

            const existingLinks = records.map((record) => record.Link);

            const newRecords = newItems
                .filter((item) => !existingLinks.includes(item.link))
                .map((item) => ({
                    Title: item.title,
                    Link: item.link,
                    'Published At': this.formatDate(item.pubDate),
                }));

            if (newRecords.length === 0) {
                logger.info('No new feed data to commit. Skipping update.');
                return;
            }

            const allRecords = [...newRecords, ...records];

            const sortedRecords = allRecords.sort((a, b) => {
                const dateA = DateTime.fromFormat(a['Published At'], 'yyyy-MM-dd HH:mm:ss');
                const dateB = DateTime.fromFormat(b['Published At'], 'yyyy-MM-dd HH:mm:ss');
                return dateB - dateA;
            });

            const updatedCsvContent = await new Promise((resolve, reject) => {
                stringify(sortedRecords, { header: true }, (err, output) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(output);
                    }
                });
            });

            const commitMessage = `Update RSS feed data (${newRecords.length} new item${newRecords.length !== 1 ? 's' : ''}) - ${DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd HH:mm:ss')}`;

            await this.octokit.repos.createOrUpdateFileContents({
                owner: this.owner,
                repo: this.repo,
                path,
                message: commitMessage,
                content: Buffer.from(updatedCsvContent).toString('base64'),
                sha: sha,
            });

            logger.info(`Successfully committed ${newRecords.length} new items to GitHub`);
        } catch (error) {
            logger.error('Error committing updates to GitHub repository:', error);
            throw error; // Propagate the error
        }
    }

    async retrieveFeedUrls(feedUrlsPath) {
        try {
            const response = await this.octokit.repos.getContent({
                owner: this.owner,
                repo: this.repo,
                path: feedUrlsPath,
            });
            const feedUrlsContent = Buffer.from(response.data.content, 'base64').toString();
            return JSON.parse(feedUrlsContent);
        } catch (error) {
            logger.error('Error retrieving feed URLs from GitHub repository:', error);
            throw error;
        }
    }

    formatDate(pubDate) {
        const manilaTime = pubDate ? DateTime.fromJSDate(new Date(pubDate)).setZone('Asia/Manila') : DateTime.now().setZone('Asia/Manila');
        return manilaTime.toFormat('yyyy-MM-dd HH:mm:ss');
    }
}

class FeedParser {
    constructor(maxRetries, retryDelay, maxItems = 100) {
        this.maxRetries = maxRetries;
        this.retryDelay = retryDelay;
        this.maxItems = maxItems;
    }

    async parseFeed(url, processedState, retryCount = 0) {
        try {
            console.log(`Checking feed: ${url}`);
            logger.info(`Checking feed: ${url}`);
            const httpsAgent = new https.Agent({
                rejectUnauthorized: false,
            });

            const response = await axios.get(url, {
                httpsAgent,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                },
                timeout: 30000, // 30 seconds timeout
            });
            const feed = parseFeed(response.data);

            const lastBuildDate = feed.updated || feed.pubDate ? DateTime.fromJSDate(new Date(feed.updated || feed.pubDate)).setZone('Asia/Manila').toMillis() : 0;
            const processedBuildDate = processedState[url] || 0;

            const newItems = [];
            if (lastBuildDate > processedBuildDate) {
                for (const item of feed.items.slice(0, this.maxItems)) {
                    const itemPubDate = item.pubDate ? DateTime.fromJSDate(new Date(item.pubDate)).setZone('Asia/Manila').toMillis() : 0;
                    if (itemPubDate > processedBuildDate) {
                        newItems.push(item);
                    }
                }
                processedState[url] = lastBuildDate;
            }
            logger.info(`Found ${newItems.length} new items for feed: ${url}`);
            return { items: newItems, hasError: false };
        } catch (error) {
            if (this.shouldRetry(error, retryCount)) {
                console.log(`Retrying feed: ${url}`);
                logger.warn(`Retrying feed: ${url}`);
                await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
                return this.parseFeed(url, processedState, retryCount + 1);
            } else {
                console.log(`Problem with feed: ${url}`);
                logger.error(`Error parsing feed: ${url}`, error);
                return { items: [], hasError: true };
            }
        }
    }

    shouldRetry(error, retryCount) {
        return (
            retryCount < this.maxRetries &&
            (error.code === 'ECONNRESET' ||
                error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT')
        );
    }
}

class RSSFeedNotifier {
    constructor() {
        this.config = this.readConfigFile();
        this.processedState = this.loadProcessedState();
        this.discordNotifier = new DiscordNotifier(this.config.discordWebhookUrl, this.config.discordErrorWebhookUrl);
        this.githubIntegration = new GitHubIntegration(this.config.githubOwner, this.config.githubRepo, this.config.githubToken);
        this.feedParser = new FeedParser(this.config.maxRetries, this.config.retryDelay, this.config.maxItemsPerFeed);
    }

    readConfigFile() {
        try {
            const config = JSON.parse(fs.readFileSync('config.json'));
            this.validateConfig(config);
            return config;
        } catch (error) {
            console.error('Error reading or parsing the configuration file:', error);
            logger.error('Error reading or parsing the configuration file:', error);
            process.exit(1);
        }
    }

    validateConfig(config) {
        const {
            discordWebhookUrl,
            discordErrorWebhookUrl,
            checkInterval,
            githubToken,
            githubRepo,
            githubOwner,
            feedUrlsPath,
            maxRetries,
            retryDelay,
            processedStateFile,
            dataFile,
            sendDiscordNotifications,
            maxItemsPerFeed,
        } = config;

        this.validateRequiredProperty('discordWebhookUrl', discordWebhookUrl, 'string');
        this.validateDiscordWebhookUrl('discordWebhookUrl', discordWebhookUrl);

        this.validateRequiredProperty('discordErrorWebhookUrl', discordErrorWebhookUrl, 'string');
        this.validateDiscordWebhookUrl('discordErrorWebhookUrl', discordErrorWebhookUrl);

        this.validateRequiredProperty('checkInterval', checkInterval, 'number', { min: 0 });
        this.validateRequiredProperty('githubToken', githubToken, 'string');
        this.validateRequiredProperty('githubRepo', githubRepo, 'string');
        this.validateRequiredProperty('githubOwner', githubOwner, 'string');
        this.validateRequiredProperty('feedUrlsPath', feedUrlsPath, 'string');
        this.validateRequiredProperty('maxRetries', maxRetries, 'number', { min: 0 });
        this.validateRequiredProperty('retryDelay', retryDelay, 'number', { min: 0 });
        this.validateRequiredProperty('processedStateFile', processedStateFile, 'string');
        this.validateRequiredProperty('dataFile', dataFile, 'string');
        this.validateRequiredProperty('sendDiscordNotifications', sendDiscordNotifications, 'boolean');
        this.validateRequiredProperty('maxItemsPerFeed', maxItemsPerFeed, 'number', { min: 1 });
    }

    validateRequiredProperty(name, value, type, options = {}) {
        if (typeof value !== type) {
            throw new Error(`Invalid ${name} value. It must be a ${type}.`);
        }

        if (type === 'number') {
            if (options.min !== undefined && value <= options.min) {
                throw new Error(`Invalid ${name} value. It must be greater than ${options.min}.`);
            }
        }
    }

    validateDiscordWebhookUrl(name, value) {
        const discordWebhookUrlPrefix = 'https://discord.com/api/webhooks/';

        if (!value.startsWith(discordWebhookUrlPrefix)) {
            throw new Error(`Invalid ${name} value. It must start with "${discordWebhookUrlPrefix}".`);
        }
    }

    loadProcessedState() {
        if (fs.existsSync(this.config.processedStateFile)) {
            try {
                const processedState = JSON.parse(fs.readFileSync(this.config.processedStateFile));
                console.log('Loaded processed state from file');
                logger.info('Loaded processed state from file');
                return processedState;
            } catch (error) {
                console.error('Error reading or parsing the processed state file:', error);
                logger.error('Error reading or parsing the processed state file:', error);
                return {};
            }
        }
        console.log('No existing processed state file found. Starting fresh.');
        logger.info('No existing processed state file found. Starting fresh.');
        return {};
    }

    saveProcessedState() {
        try {
            fs.writeFileSync(this.config.processedStateFile, JSON.stringify(this.processedState, null, 2));
            console.log(`Processed state saved to file: ${this.config.processedStateFile}`);
            logger.info(`Processed state saved to file: ${this.config.processedStateFile}`);
        } catch (error) {
            console.error('Error writing the processed state to file:', error);
            logger.error('Error writing the processed state to file:', error);
        }
    }

    async checkFeedsAndNotify() {
        console.log('Checking RSS feeds...');
        logger.info('Starting feed check');
        const limit = pLimit(5); // Limit concurrency to 5 simultaneous requests
        const feedPromises = this.config.feedUrls.map(url =>
            limit(() => this.feedParser.parseFeed(url, this.processedState))
        );
        const feedResults = await Promise.allSettled(feedPromises);

        const newItems = [];
        const errorFeeds = [];

        feedResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                if (result.value.hasError) {
                    errorFeeds.push(this.config.feedUrls[index]);
                } else {
                    newItems.push(...result.value.items);
                }
            } else {
                errorFeeds.push(this.config.feedUrls[index]);
                logger.error(`Error parsing feed: ${this.config.feedUrls[index]}`, result.reason);
            }
        });

        if (errorFeeds.length > 0) {
            console.log('Problematic feeds:');
            errorFeeds.forEach(url => console.log(` - ${url}`));
            const errorMessage = 'One or more feeds encountered parsing errors.';
            const errorFeedUrls = errorFeeds.join('\n');
            await this.discordNotifier.sendErrorNotification(`${errorMessage}\nFeed URL(s):\n${errorFeedUrls}`);
        }

        if (newItems.length > 0) {
            await this.githubIntegration.commitUpdates(newItems, this.config.dataFile);
            console.log(`${newItems.length} new items found and committed to GitHub`);

            if (this.config.sendDiscordNotifications) {
                console.log('Sending Discord notifications...');
                const notificationPromises = newItems.map((item) => this.discordNotifier.sendNotification(item));
                await Promise.all(notificationPromises);
                console.log('Discord notifications sent');
            } else {
                console.log('Discord notifications are disabled.');
            }
        } else {
            console.log('No new updates found.');
        }

        this.saveProcessedState();
        console.log('Feed checking completed.');
        logger.info(`Feed check completed. ${newItems.length} new items found.`);
    }

    async retrieveFeedUrlsFromGitHub() {
        try {
            this.config.feedUrls = await this.githubIntegration.retrieveFeedUrls(this.config.feedUrlsPath);
            console.log(`Retrieved ${this.config.feedUrls.length} feed URLs from GitHub`);
            logger.info(`Retrieved ${this.config.feedUrls.length} feed URLs from GitHub`);

            // Update the processedState with the retrieved feedUrls
            for (const url of this.config.feedUrls) {
                if (!this.processedState[url]) {
                    this.processedState[url] = 0;
                }
            }
        } catch (error) {
            console.log('Error retrieving feed URLs from GitHub');
            logger.error('Error retrieving feed URLs from GitHub repository:', error);
            process.exit(1);
        }
    }

    gracefulShutdown() {
        console.log('Shutting down...');
        logger.info('Shutting down...');
        this.saveProcessedState();
        process.exit(0);
    }

    async start() {
        console.log('Starting the RSS Feed Notifier...');
        logger.info('Starting the RSS Feed Notifier...');
        await this.retrieveFeedUrlsFromGitHub();
        try {
            await this.checkFeedsAndNotify();
        } catch (error) {
            console.log('Error during initial feed check');
            logger.error('Error during initial feed check:', error);
        }
        setInterval(async () => {
            await this.retrieveFeedUrlsFromGitHub();
            try {
                await this.checkFeedsAndNotify();
            } catch (error) {
                console.log('Error during scheduled feed check');
                logger.error('Error during scheduled feed check:', error);
            }
        }, this.config.checkInterval);
        process.on('SIGINT', () => this.gracefulShutdown());
        process.on('SIGTERM', () => this.gracefulShutdown());
    }
}

const rssFeedNotifier = new RSSFeedNotifier();
rssFeedNotifier.start();