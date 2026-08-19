#!/bin/sh
# Einmaliger Bootstrap fuer einen frischen RunPod-GPU-Pod (siehe README,
# Abschnitt "RunPod-Deployment"). Legt die von docker-compose.yml als
# "external" erwarteten Volumes an - die sind dort bewusst NICHT automatisch
# erzeugt, damit ein Projektname-Wechsel nicht heimlich ein neues, leeres
# Volume statt der echten Daten liefert (siehe Kommentar dort); auf einem
# frischen Pod existieren sie aber noch nie, deshalb hier explizit anlegen.
# Baut danach den Vorschau/Test-Runner (laeuft nie von selbst, siehe
# "preview-runner"-Service) und startet den vollen Stack inklusive Ollama.
#
# Bei einer abgerechneten GPU-Stunde soll moeglichst wenig davon fuers Setup
# drauf gehen - deshalb ein Schritt statt einer Doku zum Abtippen.
set -e
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Hinweis: .env aus .env.example angelegt - OLLAMA_MODEL bei Bedarf anpassen."
fi

docker volume create scrumy_scrumy_db_data >/dev/null
docker volume create scrumy_scrumy_workspaces >/dev/null

docker compose build preview-runner
docker compose --profile ollama up -d --build

MODEL=$(grep -m1 '^OLLAMA_MODEL=' .env | cut -d= -f2- | tr -d '"')
MODEL=${MODEL:-llama3.1:8b}

echo "Warte auf Ollama-Modell ($MODEL)..."
until docker compose exec -T ollama ollama list 2>/dev/null | grep -qF "$MODEL"; do
  sleep 5
done

echo
echo "Bereit. Scrumy laeuft auf Port 3001 dieses Pods."
echo "Erststart ohne Daten? Demo-Kunde optional seeden mit:"
echo "  docker compose exec app npm run db:seed"
