FROM node:20-alpine AS builder
WORKDIR /app
# openssl necessario para Prisma gerar o client correto para Alpine
RUN apk add --no-cache openssl
COPY package*.json ./
COPY prisma ./prisma/
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
# CRITICO: FFmpeg para conversao de audio OGG/Opus + openssl para Prisma
RUN apk add --no-cache ffmpeg openssl
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma
RUN mkdir -p /tmp/audio && chmod 777 /tmp/audio
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/main"]
