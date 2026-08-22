# syntax=docker/dockerfile:1
#
# Laufzeit fuer das "check_in_browser"-Werkzeug (siehe src/lib/browserCheck.ts):
# ein echter Chromium, der die laufende Anwendung eines Projekts so aufruft,
# wie ein Mensch sie im Browser aufruft.
#
# Bewusst NICHT das offizielle Playwright-Image (~2 GB, bringt alle drei
# Browser-Engines mit): Geprueft wird immer dieselbe Frage – "geht die Seite im
# Browser auf und was bricht dabei" – dafuer reicht der Chromium aus Alpines
# Paketquelle plus "playwright-core", das ohne eigenen Browser-Download
# auskommt und den vorhandenen per "executablePath" ansteuert.
#
# Kein Workspace-Volume: Der Container liest keine Projektdateien, er spricht
# ueber "--network host" nur den veroeffentlichten Port des laufenden
# Compose-Stacks an (siehe runBrowserProbe in src/lib/browserCheck.ts).
FROM node:22-alpine

# nss/freetype/harfbuzz/font sind Chromiums Laufzeitabhaengigkeiten – ohne sie
# startet der Browser gar nicht bzw. rendert keinen Text.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont

# playwright-core laedt beim Installieren KEINE Browser herunter (im Gegensatz
# zu "playwright"); der Pfad unten ist der Chromium aus dem apk-Paket oben.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium-browser \
    NODE_PATH=/usr/local/lib/node_modules
RUN npm install -g playwright-core@1.49.1

# Chromium laeuft nicht als root (auch mit --no-sandbox nicht zuverlaessig),
# und ein Browser, der fremde, agentengenerierte Seiten aufmacht, hat als root
# ohnehin nichts zu suchen.
RUN addgroup --system --gid 1001 runner \
  && adduser --system --uid 1001 --ingroup runner --home /home/runner runner
USER runner
WORKDIR /home/runner

ENTRYPOINT ["node"]
