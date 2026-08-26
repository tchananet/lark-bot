FROM node:22-bookworm-slim

WORKDIR /app

# Nécessaire si better-sqlite3 doit être compilé
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/downloads

CMD ["node", "index.js"]