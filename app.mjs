import fs from 'fs';
import https from 'https';
import axios from 'axios';
import { DateTime } from 'luxon';
import { Octokit } from '@octokit/rest';
import { parse } from 'csv-parse';
import { parseFeed } from 'htmlparser2';
import { stringify } from 'csv-stringify';
import winston from 'winston';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
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

            this.handleRateLimit(response);

            logger.info(`Notification sent for item: ${item.title}`);
        } catch (error) {
            this.handleError(error, item);
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

            this.handleRateLimit(response);

            logger.info(`Error notification sent: ${message}`);
        } catch (error) {
            logger.error('Error sending Discord error notification:', error);
        }
    }

    handleRateLimit(response) {
        const rateLimitRemaining = parseInt(response.headers['x-ratelimit-remaining']);
        const rateLimitReset = parseInt(response.headers['x-ratelimit-reset']);

        if (rateLimitRemaining === 0) {
            const resetTime = new Date(rateLimitReset * 1000);
            logger.info(`Rate limit exceeded. Waiting until ${resetTime.toLocaleString()} to continue.`);
            return new Promise((resolve) => setTimeout(resolve, rateLimitReset * 1000 - Date.now()));
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

            const newRecords = newItems.map((item) => ({
                Title: item.title,
                Link: item.link,
                'Published At': this.formatDate(item.pubDate),
            }));

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

            const commitMessage = `Update RSS feed data (${newItems.length} new item${newItems.length !== 1 ? 's' : ''}) - ${DateTime.now().setZone('Asia/Manila').toFormat('yyyy-MM-dd HH:mm:ss')}`;

            await this.octokit.repos.createOrUpdateFileContents({
                owner: this.owner,
                repo: this.repo,
                path,
                message: commitMessage,
                content: Buffer.from(updatedCsvContent).toString('base64'),
                sha: sha,
            });
        } catch (error) {
            logger.error('Error committing updates to GitHub repository:', error);
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
    constructor(maxRetries, retryDelay) {
        this.maxRetries = maxRetries;
        this.retryDelay = retryDelay;
    }

    async parseFeed(url, processedState, retryCount = 0) {
        try {
            const httpsAgent = new https.Agent({
                rejectUnauthorized: false,
            });

            const response = await axios.get(url, {
                httpsAgent,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                },
            });
            const feed = parseFeed(response.data);

            const lastBuildDate = feed.updated || feed.pubDate ? DateTime.fromJSDate(new Date(feed.updated || feed.pubDate)).setZone('Asia/Manila').toMillis() : 0;
            const processedBuildDate = processedState[url] || 0;

            const newItems = [];
            if (lastBuildDate > processedBuildDate) {
                for (const item of feed.items) {
                    const itemPubDate = item.pubDate ? DateTime.fromJSDate(new Date(item.pubDate)).setZone('Asia/Manila').toMillis() : 0;
                    if (itemPubDate > processedBuildDate) {
                        newItems.push(item);
                    }
                }
                processedState[url] = lastBuildDate;
            }
            return { items: newItems, hasError: false };
        } catch (error) {
            if (this.shouldRetry(error, retryCount)) {
                logger.warn(`Temporary error for feed: ${url}. Retrying in ${this.retryDelay}ms...`);
                await new Promise((resolve) => setTimeout(resolve, this.retryDelay));
                return this.parseFeed(url, processedState, retryCount + 1);
            } else {
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
        this.feedParser = new FeedParser(this.config.maxRetries, this.config.retryDelay);
    }

    readConfigFile() {
        try {
            const config = JSON.parse(fs.readFileSync('config.json'));
            this.validateConfig(config);
            return config;
        } catch (error) {
            logger.error('Error reading or parsing the configuration file:', error);
            process.exit(1);
        }
    }

    validateConfig(config) {
        const requiredProperties = [
            'discordWebhookUrl',
            'discordErrorWebhookUrl',
            'checkInterval',
            'githubToken',
            'githubRepo',
            'githubOwner',
            'feedUrlsPath',
            'maxRetries',
            'retryDelay',
            'processedStateFile',
            'dataFile',
        ];

        for (const property of requiredProperties) {
            if (!config[property]) {
                throw new Error(`Missing required configuration property: ${property}`);
            }
        }

        if (typeof config.checkInterval !== 'number' || config.checkInterval <= 0) {
            throw new Error('Invalid checkInterval value. It must be a positive number.');
        }

        if (typeof config.maxRetries !== 'number' || config.maxRetries < 0) {
            throw new Error('Invalid maxRetries value. It must be a non-negative number.');
        }

        if (typeof config.retryDelay !== 'number' || config.retryDelay <= 0) {
            throw new Error('Invalid retryDelay value. It must be a positive number.');
        }
    }

    loadProcessedState() {
        if (fs.existsSync(this.config.processedStateFile)) {
            try {
                const processedState = JSON.parse(fs.readFileSync(this.config.processedStateFile));
                return processedState;
            } catch (error) {
                logger.error('Error reading or parsing the processed state file:', error);
                return {};
            }
        }
        return {};
    }

    saveProcessedState() {
        try {
            fs.writeFileSync(this.config.processedStateFile, JSON.stringify(this.processedState));
            logger.info(`Processed state saved to file: ${this.config.processedStateFile}`);
        } catch (error) {
            logger.error('Error writing the processed state to file:', error);
        }
    }

    async checkFeedsAndNotify() {
        logger.info('Checking RSS feeds...');
        const feedPromises = this.config.feedUrls.map((url) => this.feedParser.parseFeed(url, this.processedState));
        const feedResults = await Promise.all(feedPromises);

        const newItems = [];
        const errorFeeds = [];

        for (let i = 0; i < feedResults.length; i++) {
            const result = feedResults[i];
            const feedUrl = this.config.feedUrls[i];

            if (result.hasError) {
                errorFeeds.push(feedUrl);
            } else {
                newItems.push(...result.items);
            }
        }

        if (errorFeeds.length > 0) {
            const errorMessage = 'One or more feeds encountered parsing errors.';
            const errorFeedUrls = errorFeeds.join('\n');
            await this.discordNotifier.sendErrorNotification(`${errorMessage}\nFeed URL(s):\n${errorFeedUrls}`);
        }

        if (newItems.length > 0) {
            await this.githubIntegration.commitUpdates(newItems, this.config.dataFile);
            logger.info('Updates committed to GitHub repository');

            if (this.config.sendDiscordNotifications) {
                const notificationPromises = newItems.map((item) => this.discordNotifier.sendNotification(item));
                await Promise.all(notificationPromises);
            } else {
                logger.info('Discord notifications are disabled.');
            }
        } else {
            logger.info('No new updates found.');
        }

        this.saveProcessedState();
        logger.info('Feed checking and notification completed.');
    }

    async retrieveFeedUrlsFromGitHub() {
        try {
            this.config.feedUrls = await this.githubIntegration.retrieveFeedUrls(this.config.feedUrlsPath);
            logger.info('Feed URLs retrieved from GitHub repository.');

            // Update the processedState with the retrieved feedUrls
            for (const url of this.config.feedUrls) {
                if (!this.processedState[url]) {
                    this.processedState[url] = 0;
                }
            }
        } catch (error) {
            logger.error('Error retrieving feed URLs from GitHub repository:', error);
            process.exit(1);
        }
    }

    gracefulShutdown() {
        logger.info('Received shutdown signal. Saving processed state and exiting...');
        this.saveProcessedState();
        process.exit(0);
    }

    async start() {
        logger.info('Starting the RSS Feed Notifier...');
        await this.retrieveFeedUrlsFromGitHub();
        this.checkFeedsAndNotify();
        setInterval(async () => {
            await this.retrieveFeedUrlsFromGitHub();
            await this.checkFeedsAndNotify();
        }, this.config.checkInterval);
        process.on('SIGINT', () => this.gracefulShutdown());
        process.on('SIGTERM', () => this.gracefulShutdown());
    }
}

const rssFeedNotifier = new RSSFeedNotifier();
rssFeedNotifier.start();