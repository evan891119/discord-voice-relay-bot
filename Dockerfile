FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --omit=dev

CMD ["npm", "start"]
