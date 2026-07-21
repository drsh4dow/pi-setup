# Web access extension

Pi tools for Exa web search/content extraction, GitHub repository access, and Gemini video understanding.

## Credentials

Set environment variables before starting Pi:

- `EXA_API_KEY` — required by `web_search` and ordinary URL/PDF extraction.
- `GEMINI_API_KEY` — required only for YouTube and local-video analysis.

No extension-specific configuration file is read.

## Optional command-line tools

Capabilities are checked when used:

- `git` clones public GitHub repositories.
- `gh` adds private-repository access and authenticated API fallback.
- `ffmpeg` and `ffprobe` extract local or YouTube frames and inspect duration.
- `yt-dlp` resolves YouTube streams for frame extraction.

## Tools

- `web_search` runs at most four sequential Exa queries.
- `fetch_content` handles at most ten URLs, repositories, or videos.
- `get_search_content` retrieves an archived response by ID and optional zero-based item index.

Ordinary URL and PDF content is capped at 100,000 characters. Initial fetch output includes 30,000 characters per item; search-inline content includes 20,000 characters per result. The Session Response Archive retains the latest 20 responses per Pi session under the system temporary directory; they may survive Pi restarts until the operating system cleans `/tmp`.

GitHub clones are shallow, time out after 30 seconds, and use an automatic-clone threshold of 350 MB. Local videos are limited to 50 MB and frame requests to 12 images.

## Verification

From `~/.pi`:

```sh
bun run verify
```

Live Exa and GitHub smoke tests are opt-in:

```sh
PI_WEB_ACCESS_LIVE=1 node --test agent/extensions/pi-web-access/test/live.test.ts
```
