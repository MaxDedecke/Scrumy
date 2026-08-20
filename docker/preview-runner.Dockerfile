# syntax=docker/dockerfile:1
#
# Minimales, generisches Image fuer EINE laufende Frontend-Vorschau (siehe
# src/lib/preview.ts). Pro Vorschau startet die App einen eigenen Container
# aus diesem Image ("docker run --name scrumy-preview-<projektId> ..."),
# ressourcenbegrenzt und ohne Zugriff auf die Datenbank oder die Secrets der
# App (eigenes Netz, eigenes, sehr kleines Environment – siehe dort).
#
# Bewusst kein projektspezifisches Image: die Agenten sind frei in der
# Technologiewahl (kein fester Build-Befehl), also gibt es kein "das eine
# Frontend-Image". Was konkret laeuft (Verzeichnis/Befehl), wird beim Start
# per Environment-Variable hereingereicht (FRONTEND_DIR/KIND/SCRIPT_NAME),
# preview-entrypoint.js fuehrt es aus.
FROM node:22-alpine
WORKDIR /run

# Dieselbe UID/GID wie "nextjs" im Haupt-Dockerfile (nicht das eingebaute
# "node" mit UID 1000): die Dateien im Workspace-Volume gehoeren dieser UID,
# und nur ihr Besitzer darf dort neue Dateien anlegen (node_modules, Build-
# Cache) – mit UID 1000 gaebe es "Permission denied" beim npm install.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY docker/preview-entrypoint.js ./entrypoint.js
USER nextjs
ENTRYPOINT ["node", "/run/entrypoint.js"]
