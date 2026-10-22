# ─────────────────────────────────────────────────────────────────────────────
# Jax Nova — production image
#
# Zero dependencies, so there is no install step: the image is just Node plus
# the two source folders. Railway builds this automatically when it finds a
# Dockerfile (it always prefers Docker over Railpack).
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    JAX_DATA_DIR=/data

# su-exec lets the entrypoint drop from root to the `node` user after fixing
# volume permissions (see docker-entrypoint.sh).
RUN apk add --no-cache su-exec

WORKDIR /app

# package.json is copied first so future dependencies invalidate the cache here
COPY package.json ./
COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# /data holds generated images + motion frames. Mount a Railway volume here and
# the HUD gallery survives redeploys; without one it is simply ephemeral.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown -R node:node /app /data

EXPOSE 8787

# Railway uses its own healthcheck path during deploys; this is for plain Docker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# starts as root only long enough to take ownership of a mounted volume,
# then re-execs as `node`
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
