FROM node:24-alpine

# Include FFmpeg for optional server-side media transcoding; no transcoding runs unless requested.
RUN apk add --no-cache ffmpeg

# Install reviewed IMAP, SMTP and MIME packages for the Mail Workspace.
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev --no-audit --no-fund
ENV NODE_ENV=production \
    PORT=3920 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    CACHE_DIR=/data/imgcache \
    REFRESH_HOURS=12 \
    TZ=Asia/Tokyo

COPY server.js entrypoint.sh ./
COPY lib ./lib
COPY public ./public
COPY data ./data-seed

RUN chmod +x entrypoint.sh

EXPOSE 3920

HEALTHCHECK --interval=60s --timeout=6s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3920/healthz >/dev/null || exit 1

ENTRYPOINT ["./entrypoint.sh"]
