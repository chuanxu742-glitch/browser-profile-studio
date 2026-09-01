FROM node:22-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright install --with-deps firefox chromium

COPY src ./src
COPY tsconfig.json tsconfig.build.json ./
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
