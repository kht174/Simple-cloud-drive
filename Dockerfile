FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public
COPY netdisk.sh ./

ENV PORT=3000 \
    NETDISK_DIR=/app/storage \
    NETDISK_HOST=0.0.0.0
RUN mkdir -p /app/storage /app/config

VOLUME ["/app/storage", "/app/storage.users"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/session',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
