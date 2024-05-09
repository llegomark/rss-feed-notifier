# RSS Feed Notifier

The RSS Feed Notifier is a Node.js application that monitors RSS feeds, sends notifications to a configurable notification service (Discord, Slack, or Microsoft Teams) when new items are found, and commits the URLs of the new items to a GitHub repository as a CSV file.

## Features

- Monitors multiple RSS feeds for new items
- Supports multiple notification services: Discord, Slack, and Microsoft Teams
- Sends notifications with rate limit handling (for Discord)
- Commits new item URLs to a GitHub repository as a CSV file
- Separates the date and time in the CSV file and converts the time to GMT+8 Manila time zone
- Removes tracking parameters from URLs before committing to the repository
- Retries failed requests with exponential backoff
- Sends error notifications to a separate webhook for better error handling
- Fallback mechanism to save data to a JSON file when Redis is not available
- Configurable check interval and notification delay
- Option to enable or disable notifications

## Prerequisites

Before running the RSS Feed Notifier, make sure you have the following:

- Node.js installed on your machine
- Webhook URLs for the desired notification service (Discord, Slack, or Microsoft Teams)
- Separate webhook URLs for receiving error notifications (for each notification service)
- A GitHub personal access token with repository access
- An Upstash Redis database for storing last checked timestamps (optional)
- A GitHub repository where the CSV file will be committed
- A CSV file in the GitHub repository where the new item URLs will be stored (optional)
- A list of RSS feed URLs to monitor

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
   NOTIFICATION_SERVICE=discord
   FEEDS=https://example.com/feed1.xml,https://example.com/feed2.xml
   WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook-url
   ERROR_WEBHOOK_URL=https://discord.com/api/webhooks/your-error-webhook-url
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/your-slack-webhook-url
   SLACK_ERROR_WEBHOOK_URL=https://hooks.slack.com/services/your-slack-error-webhook-url
   TEAMS_WEBHOOK_URL=https://outlook.office.com/webhook/your-teams-webhook-url
   TEAMS_ERROR_WEBHOOK_URL=https://outlook.office.com/webhook/your-teams-error-webhook-url
   GITHUB_ACCESS_TOKEN=your-github-access-token
   GITHUB_REPO_OWNER=your-github-username
   GITHUB_REPO_NAME=your-repository-name
   GITHUB_REPO_FILE_PATH=path/to/file.csv
   UPSTASH_REDIS_REST_URL=your-upstash-redis-rest-url
   UPSTASH_REDIS_REST_TOKEN=your-upstash-redis-rest-token
   CHECK_INTERVAL=300000
   NOTIFICATION_DELAY=1000
   NOTIFICATIONS_ENABLED=true
   ```

   Replace the placeholders with your actual values.

4. Start the application:

   ```bash
   npm start
   ```

   The RSS Feed Notifier will start monitoring the specified RSS feeds and send notifications to the configured notification service when new items are found. It will also commit the URLs of the new items to the specified GitHub repository as a CSV file.

## Configuration

The RSS Feed Notifier can be configured using the following environment variables:

- `NOTIFICATION_SERVICE`: The notification service to use (discord, slack, or teams).
- `FEEDS`: A comma-separated list of RSS feed URLs to monitor.
- `WEBHOOK_URL`: The Discord webhook URL for receiving notifications.
- `ERROR_WEBHOOK_URL`: The Discord webhook URL for receiving error notifications.
- `SLACK_WEBHOOK_URL`: The Slack webhook URL for receiving notifications.
- `SLACK_ERROR_WEBHOOK_URL`: The Slack webhook URL for receiving error notifications.
- `TEAMS_WEBHOOK_URL`: The Microsoft Teams webhook URL for receiving notifications.
- `TEAMS_ERROR_WEBHOOK_URL`: The Microsoft Teams webhook URL for receiving error notifications.
- `GITHUB_ACCESS_TOKEN`: Your GitHub personal access token with repository access.
- `GITHUB_REPO_OWNER`: The owner of the GitHub repository where the CSV file will be committed.
- `GITHUB_REPO_NAME`: The name of the GitHub repository where the CSV file will be committed.
- `GITHUB_REPO_FILE_PATH`: The path to the CSV file within the GitHub repository.
- `UPSTASH_REDIS_REST_URL`: The URL of your Upstash Redis database (optional).
- `UPSTASH_REDIS_REST_TOKEN`: The access token for your Upstash Redis database (optional).
- `CHECK_INTERVAL`: The interval (in milliseconds) at which the RSS feeds will be checked for new items.
- `NOTIFICATION_DELAY`: The delay (in milliseconds) between sending notifications.
- `NOTIFICATIONS_ENABLED`: Whether notifications are enabled (true or false).

## Fallback Mechanism

The RSS Feed Notifier includes a fallback mechanism to save data to a JSON file when Redis is not available. If the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` environment variables are not provided, the application will automatically use the JSON file (`data.json`) to store the last checked timestamps for each feed.

The JSON file will be created automatically in the project root directory when data needs to be saved. The application will handle the creation, reading, and writing of the JSON file without any manual intervention.

## License

This project is licensed under the [MIT License](LICENSE).