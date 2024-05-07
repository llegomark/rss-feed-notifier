# RSS Feed Notifier

The RSS Feed Notifier is a Node.js application that monitors RSS feeds, sends notifications to a Discord webhook when new items are found, and commits the URLs of the new items to a GitHub repository as a CSV file.

## Features

- Monitors multiple RSS feeds for new items
- Sends notifications to a Discord webhook with rate limit handling
- Commits new item URLs to a GitHub repository as a CSV file
- Separates the date and time in the CSV file and converts the time to GMT+8 Manila time zone
- Removes tracking parameters from URLs before committing to the repository
- Retries failed requests with exponential backoff
- Sends error notifications to a separate Discord webhook for better error handling

## Prerequisites

Before running the RSS Feed Notifier, make sure you have the following:

- Node.js installed on your machine
- A Discord webhook URL for receiving notifications
- A separate Discord webhook URL for receiving error notifications
- A GitHub personal access token with repository access
- An Upstash Redis database for storing last checked timestamps

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/llegomark/rss-feed-notifier.git
   ```

2. Install the dependencies:

   ```bash
   cd rss-feed-notifier
   npm install
   ```

3. Create a `.env` file in the project root and provide the necessary environment variables:

   ```plaintext
   FEEDS=https://example.com/feed1.xml,https://example.com/feed2.xml
   WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook-url
   ERROR_WEBHOOK_URL=https://discord.com/api/webhooks/your-error-webhook-url
   GITHUB_ACCESS_TOKEN=your-github-access-token
   GITHUB_REPO_OWNER=your-github-username
   GITHUB_REPO_NAME=your-repository-name
   GITHUB_REPO_FILE_PATH=path/to/file.csv
   UPSTASH_REDIS_REST_URL=your-upstash-redis-rest-url
   UPSTASH_REDIS_REST_TOKEN=your-upstash-redis-rest-token
   CHECK_INTERVAL=300000
   NOTIFICATION_DELAY=1000
   ```

   Replace the placeholders with your actual values.

4. Start the application:

   ```bash
   npm start
   ```

   The RSS Feed Notifier will start monitoring the specified RSS feeds and send notifications to the configured Discord webhook when new items are found. It will also commit the URLs of the new items to the specified GitHub repository as a CSV file.

## Configuration

The RSS Feed Notifier can be configured using the following environment variables:

- `FEEDS`: A comma-separated list of RSS feed URLs to monitor.
- `WEBHOOK_URL`: The Discord webhook URL for receiving notifications.
- `ERROR_WEBHOOK_URL`: The Discord webhook URL for receiving error notifications.
- `GITHUB_ACCESS_TOKEN`: Your GitHub personal access token with repository access.
- `GITHUB_REPO_OWNER`: The owner of the GitHub repository where the CSV file will be committed.
- `GITHUB_REPO_NAME`: The name of the GitHub repository where the CSV file will be committed.
- `GITHUB_REPO_FILE_PATH`: The path to the CSV file within the GitHub repository.
- `UPSTASH_REDIS_REST_URL`: The URL of your Upstash Redis database.
- `UPSTASH_REDIS_REST_TOKEN`: The access token for your Upstash Redis database.
- `CHECK_INTERVAL`: The interval (in milliseconds) at which the RSS feeds will be checked for new items.
- `NOTIFICATION_DELAY`: The delay (in milliseconds) between sending notifications to the Discord webhook.

## License

This project is licensed under the [MIT License](LICENSE).