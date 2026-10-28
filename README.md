# @novada/n8n-nodes-novada

This is an n8n community node. It lets you use [Novada](https://www.novada.com/) in your n8n workflows.

Novada provides a Scraper API that returns structured data from Google, Amazon, YouTube, TikTok, Instagram, LinkedIn, Walmart and other platforms, and a Web Unblocker that fetches any web page while handling blocks, CAPTCHAs and JavaScript rendering.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation. The package name is `@novada/n8n-nodes-novada`.

## Operations

**Scraper API**

- **Run Scraper**: run any Novada scraper by its platform (`scraper_name`) and scraper ID (`scraper_id`). Search scenarios return results immediately. For asynchronous scenarios (e-commerce, social media, video), the node waits for the task to finish and returns the records.
- **Get Task Status**: check the status (`Running`, `Ready`, `Failed`) of up to 200 tasks.
- **Get Task Result**: get the records of a finished task as items (JSON), or download them as a CSV or XLSX file.

**Web Unblocker**

- **Scrape URL**: fetch any page as HTML or a PNG screenshot, with optional JavaScript rendering, country targeting, wait time and wait-for-selector.

**Account**

- **Get Balance**: get the remaining Scraper API balance.
- **Get Usage**: get daily Scraper API and Web Unblocker consumption for a time range.

The node can also be used as a tool by the n8n AI Agent.

## Credentials

1. Sign up at [novada.com](https://www.novada.com/) and buy a Scraper API or Web Unblocker plan.
2. Open the [Novada dashboard](https://dashboard.novada.com/), go to **API Playground** and copy your API key.
3. In n8n, create a new **Novada API** credential and paste the key into **API Key**.

The key is sent as `Authorization: Bearer <API key>`.

## Compatibility

Tested with n8n 2.x. Requires an n8n version that supports community nodes.

## Usage

**Finding the platform and scraper ID**

Every scraper is identified by two values from the [Scraper API documentation](https://developer.novada.com/novada/advanced-proxy-solutions/scraper-api/target-sites-supported-by-scraper-api):

| Example                    | Platform      | Scraper ID                   | Parameter Style  | Parameters                                                 |
| -------------------------- | ------------- | ---------------------------- | ---------------- | ---------------------------------------------------------- |
| Google search              | `google.com`  | `google_search`              | Top-Level Fields | `{"q": "coffee shops", "json": "1"}`                       |
| Amazon products by keyword | `amazon.com`  | `amazon_product_keywords`    | Scraper Params   | `[{"keyword": "coffee", "max_pages": "1"}]`                |
| YouTube video posts        | `youtube.com` | `youtube_video-post_explore` | Scraper Params   | `[{"url": "https://www.youtube.com/watch?v=HAwTwmzgNc4"}]` |

**Long-running tasks**

If a task may take longer than a few minutes, turn off **Wait for Result**. The node then returns the `task_id`. Use **Get Task Status** and **Get Task Result** later in the same or another workflow.

**Example workflows**

- Search Google with Novada, then pass the results to an AI Agent that writes a summary.
- Collect Amazon products for a keyword every day and append them to Google Sheets.
- Take a PNG screenshot of a competitor page and send it to Slack.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Novada Scraper API documentation](https://developer.novada.com/novada/advanced-proxy-solutions/scraper-api)
- [Novada Web Unblocker documentation](https://developer.novada.com/novada/advanced-proxy-solutions/web-unblocker)

## Version history

### 0.1.0

Initial release: Scraper API (run, task status, task result), Web Unblocker (scrape URL) and Account (balance, usage).
