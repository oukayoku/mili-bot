FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 需要在安装时编译原生模块,装一下编译工具链
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
