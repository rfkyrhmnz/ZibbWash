# Image untuk hosting berbasis container (mis. Suga). Proyek tanpa dependensi, jadi tidak ada langkah npm install.
# Data utama disimpan di Upstash (UPSTASH_REDIS_REST_URL dan UPSTASH_REDIS_REST_TOKEN); /app/data hanya cache kerja.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Folder cache yang boleh ditulis pengguna non-root.
RUN mkdir -p /app/data && chown node:node /app/data

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
