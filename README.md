# Better RSS Feed Notifier

The Better RSS Feed Notifier is a high-performance Node.js application that monitors RSS feeds, sends notifications to Discord, and commits updates to a GitHub repository. It leverages asynchronous programming, optimized libraries, and follows best practices to deliver efficient and reliable performance.

## Features

- Monitors multiple RSS feeds for new updates
- Sends real-time notifications to Discord using webhooks
- Commits updates to a GitHub repository as a CSV file
- Handles rate limiting and error retries for seamless operation
- Supports graceful shutdown and process signal handling
- Adheres to SOLID principles for clean and maintainable code
- Retrieves feed URLs from a GitHub repository for easy configuration management
- Handles connection resets, network failures, and feed parsing errors with retries
- Converts dates to Manila time zone for consistent formatting
- Sorts and deduplicates records before committing to GitHub
- Utilizes a logger for comprehensive logging and error tracking
- Sends error notifications to a separate Discord webhook for better error monitoring
- Validates configuration file properties to ensure proper setup
- Modular design with separate classes for Discord notifications, GitHub integration, and feed parsing

## Performance

The Better RSS Feed Notifier is designed with performance and efficiency in mind. It utilizes the following techniques and libraries to achieve optimal performance:

- Asynchronous programming with `async/await` for non-blocking I/O operations
- `axios` library for fast and efficient HTTP requests
- `htmlparser2` library for quick parsing of RSS feeds
- `@octokit/rest` for seamless integration with the GitHub API
- `csv-parse` and `csv-stringify` for efficient CSV parsing and generation
- `luxon` for accurate date and time manipulation

With its optimized code and carefully selected dependencies, the RSS Feed Notifier can handle a large number of RSS feeds and deliver notifications in real-time, ensuring that you stay up-to-date with the latest updates.

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/llegomark/rss-feed-notifier
   ```

2. Install the dependencies:
   ```
   cd rss-feed-notifier
   npm install
   ```

3. Create a `config.json` file in the project root with the following structure:
   ```json
   {
     "discordWebhookUrl": "YOUR_DISCORD_WEBHOOK_URL",
     "discordErrorWebhookUrl": "YOUR_DISCORD_ERROR_WEBHOOK_URL",
     "checkInterval": 300000,
     "githubToken": "YOUR_GITHUB_ACCESS_TOKEN",
     "githubRepo": "YOUR_GITHUB_REPOSITORY",
     "githubOwner": "YOUR_GITHUB_USERNAME",
     "feedUrlsPath": "feed_urls.json",
     "sendDiscordNotifications": false,
     "maxRetries": 3,
     "retryDelay": 5000,
     "processedStateFile": "processed_state.json",
     "dataFile": "data.csv",
     "maxItemsPerFeed": 100
   }
   ```

4. Create a `feed_urls.json` file in the project root with the following structure:
   ```json
   [
     "https://example.com/feed/",
     "https://www.example.com/feed/",
     "http://example.com/feed/"
   ]
   ```

## Running on Amazon AWS with PM2

This application is designed to run on Amazon AWS using PM2 for process management. Follow these steps to set up and run the application:

1. Install PM2 globally on your AWS instance:
   ```
   sudo npm install -g pm2
   ```

2. Navigate to the project directory:
   ```
   cd /path/to/rss-feed-notifier
   ```

3. Start the application with PM2:
   ```
   pm2 start app.mjs --name "better-rss-feed-notifier"
   ```

4. Set up PM2 to start on system boot:
   ```
   pm2 startup systemd
   ```
   Follow the instructions provided by the command to complete the setup.

5. Save the current PM2 process list:
   ```
   pm2 save
   ```

6. To view the application logs:
   ```
   pm2 logs better-rss-feed-notifier
   ```

7. To restart the application:
   ```
   pm2 restart better-rss-feed-notifier
   ```

8. To stop the application:
   ```
   pm2 stop better-rss-feed-notifier
   ```

## Changelog

The following changes have been made to the `app.mjs` source code:

- Implemented concurrent feed parsing with `p-limit` to improve performance
- Added more robust error handling and logging
- Improved the feed parsing process to handle various edge cases
- Enhanced the GitHub integration to handle larger datasets more efficiently
- Implemented a more comprehensive configuration validation system
- Added support for a separate Discord webhook for error notifications
- Improved the processed state management to be more resilient

## Configuration

The Better RSS Feed Notifier can be configured using the `config.json` file. Here's a description of each configuration option:

- `discordWebhookUrl`: The URL of the Discord webhook where notifications will be sent.
- `discordErrorWebhookUrl`: The URL of the Discord webhook where error notifications will be sent.
- `checkInterval`: The interval at which the RSS feeds should be checked, specified in milliseconds.
- `githubToken`: Your GitHub access token for committing updates to the repository.
- `githubRepo`: The name of the GitHub repository where updates will be committed.
- `githubOwner`: Your GitHub username or the owner of the repository.
- `feedUrlsPath`: The path to the JSON file containing the RSS feed URLs to monitor.
- `sendDiscordNotifications`: A boolean indicating whether to send Discord notifications or not.
- `maxRetries`: The maximum number of retries for failed feed requests.
- `retryDelay`: The delay in milliseconds between each retry attempt.
- `processedStateFile`: The path to the JSON file storing the processed state of the feeds.
- `dataFile`: The path to the CSV file where the feed data will be stored.
- `maxItemsPerFeed`: The maximum number of items to process per feed.

Make sure to replace the placeholders with your actual values.

## Contributing

Contributions are welcome! If you find any issues or have suggestions for improvements, please open an issue or submit a pull request.

## License

This project is licensed under the [MIT License](LICENSE).