FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
RUN npx tsc --noEmit

ENV PORT=8787
EXPOSE 8787

CMD ["npm","start"]
