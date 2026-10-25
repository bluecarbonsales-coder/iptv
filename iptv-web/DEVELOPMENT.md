# Local development (no Docker)

The app is a Node.js server with plain HTML/CSS/browser JavaScript. Docker is not required for development.

## Requirements

- Node.js 24 LTS
- npm (bundled with Node.js)
- Internet access on first launch to download the IPTV channel catalogue

## Start from a clean checkout

From the repository root:

```bash
cd iptv-web
npm ci
npm run setup
npm run dev
```

Then open **http://127.0.0.1:3920**.

- `npm run setup` creates a private local `.env` with unique development tokens. It does not overwrite an existing `.env`.
- `npm run dev` starts Node's built-in watch mode. Server-side JavaScript changes restart the server automatically; refresh the browser to see frontend changes.
- The channel catalogue downloads in the background on first launch. The first load may show an empty channel list until the download completes.
- Stop the server with `Ctrl+C`.

## Other commands

```bash
npm test       # run automated tests
npm start      # run without watch mode
```

No bundler or frontend build step is needed. The app uses the Node.js standard library for its web server and only installs its existing mail-workspace dependencies via npm.

## Notes

- Local configuration and data are stored in `.env` and `data/`; do not commit secrets or personal data.
- TMDB/OMDb metadata keys are optional for basic startup and search functionality may be limited without valid keys.
- Mail Workspace requires its own account and server configuration before it can send or receive mail.
- FFmpeg and Docker are not needed for the current local development loop. FFmpeg-based transcoding is not implemented merely by having FFmpeg in the Docker image.
