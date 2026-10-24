FROM node:22-alpine

# No build step and no npm dependencies: the app is plain Node stdlib + static assets,
# so the image builds offline and starts in milliseconds.
WORKDIR /app
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
