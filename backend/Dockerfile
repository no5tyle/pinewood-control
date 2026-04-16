FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
RUN npx tsc --noEmit -p tsconfig.json

ENV PORT=8787
EXPOSE 8787

CMD ["npm","start"]
