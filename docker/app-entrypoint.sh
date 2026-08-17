#!/bin/sh
# Nur fuer den "app"-Dienst (siehe docker-compose.yml: dort ueberschreibt er
# ENTRYPOINT und startet zunaechst als root statt als "nextjs" aus dem
# Dockerfile). Grund: die Frontend-Vorschau (src/lib/preview.ts) startet jede
# laufende Vorschau als eigenen, ressourcenbegrenzten Sibling-Container ueber
# den gemounteten Docker-Socket – dafuer braucht der Prozess Zugriff auf
# /var/run/docker.sock.
#
# Der Socket gehoert auf dem Host einer Gruppe mit host-spezifischer GID.
# Diese GID wird hier zur Laufzeit als Gruppe angelegt und "nextjs" beitritt
# ihr, danach faellt der Prozess sofort auf den unprivilegierten "nextjs"-
# Nutzer zurueck (su-exec) – nur dieser eine Schritt braucht root, npm/next
# selbst laufen wie gehabt unprivilegiert.
set -e

if [ -S /var/run/docker.sock ]; then
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
  if ! getent group "$DOCKER_GID" >/dev/null 2>&1; then
    addgroup -g "$DOCKER_GID" dockerhost
  fi
  GROUP_NAME=$(getent group "$DOCKER_GID" | cut -d: -f1)
  addgroup nextjs "$GROUP_NAME" 2>/dev/null || true
fi

exec su-exec nextjs "$@"
