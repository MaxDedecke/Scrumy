# syntax=docker/dockerfile:1
#
# Bewusst einfach gehalten (volles node_modules statt "standalone"-Trimming):
# das Projekt wird laufend von Agenten weiterentwickelt, da zaehlt schnelle,
# nachvollziehbare Rebuilds mehr als ein minimales Image.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS builder
WORKDIR /app
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app ./

USER nextjs
EXPOSE 3000
ENV PORT=3000

# Migrationen vor jedem Start anwenden, dann den Server starten.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
