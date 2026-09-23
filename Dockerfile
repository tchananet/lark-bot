FROM node:22-bookworm-slim

WORKDIR /app

# python3, make et g++ : nécessaires si better-sqlite3 doit être compilé.
# poppler-utils : pdftoppm, qui rend en images les fiches de présence
# scannées. Quatre pages en moins d'une seconde, là où le rendu en
# JavaScript échouait à allouer sa mémoire.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/downloads /app/rapports

CMD ["node", "index.js"]
