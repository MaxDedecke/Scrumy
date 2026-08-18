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

# git gehoert zur Laufzeit dazu: Die Agenten arbeiten in echten lokalen
# Repositories (siehe src/lib/workspace.ts), Commits sind ihr Arbeitsnachweis.
#
# docker-cli + su-exec braucht sowohl "app" (siehe docker/app-entrypoint.sh,
# src/lib/preview.ts: jede Frontend-Vorschau laeuft als eigener Sibling-
# Container statt als Kindprozess in diesem Container) als auch "worker"
# (src/lib/testRun.ts: QAs automatische Pruefungen laufen genauso als
# Sibling-Container) – ein Image fuer beide Dienste. docker-cli-compose
# liefert das "docker compose"-Plugin dazu, gebraucht von src/lib/liveStack.ts
# (voller Compose-Stack des Kundenprojekts statt nur einem einzelnen
# Container).
RUN apk add --no-cache git docker-cli docker-cli-compose su-exec

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Arbeitsverzeichnis der Projekt-Repos. Existiert es schon im Image, uebernimmt
# das Docker-Volume beim ersten Start diese Rechte – sonst gehoerte es root und
# der Worker (nextjs) koennte nicht committen.
RUN mkdir -p /workspaces && chown nextjs:nodejs /workspaces
ENV WORKSPACE_ROOT=/workspaces

COPY --from=builder --chown=nextjs:nodejs /app ./
RUN chmod +x docker/app-entrypoint.sh

USER nextjs
EXPOSE 3000
ENV PORT=3000

# Migrationen vor jedem Start anwenden, dann den Server starten. "worker"
# ueberschreibt CMD (siehe docker-compose.yml) und laeuft damit als "nextjs"
# (Default hier oben) direkt durch. "app" ueberschreibt zusaetzlich
# ENTRYPOINT + user (siehe docker-compose.yml), um kurz als root den
# Docker-Socket nutzbar zu machen, bevor es selbst auf "nextjs" wechselt –
# CMD bleibt dabei unveraendert, docker/app-entrypoint.sh reicht es durch.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
