// Welcher Compose-Dienst ist die Datenbank? Das ist die einzige Stelle im
// SQL-Werkzeug (query_database) mit echter Logik – der Rest ist
// Docker-Klempnerei. Absichtlich am Image festgemacht und nicht am
// Servicenamen: Die Agenten schreiben die docker-compose.yml selbst, und im
// Timeless-Projekt heisst der Dienst tatsaechlich "postgres", nicht "db".
import assert from "node:assert/strict";
import test from "node:test";
import { pickDatabaseService } from "../src/lib/liveStack";

test("findet den Postgres-Dienst unabhaengig vom Servicenamen", () => {
  const choice = pickDatabaseService({
    frontend: { environment: { BACKEND_ORIGIN: "http://backend:3000" } },
    backend: { environment: { PGUSER: "timeless" } },
    postgres: {
      image: "postgres:16-alpine",
      environment: { POSTGRES_DB: "timeless", POSTGRES_USER: "timeless", POSTGRES_PASSWORD: "timeless" },
    },
  });
  assert.deepEqual(choice, { service: "postgres", user: "timeless", database: "timeless" });
});

test("faellt auf die Vorgaben des offiziellen Images zurueck", () => {
  const choice = pickDatabaseService({ db: { image: "postgres:17" } });
  assert.deepEqual(choice, { service: "db", user: "postgres", database: "postgres" });
});

test("POSTGRES_DB fehlt: die Datenbank heisst wie der Benutzer", () => {
  const choice = pickDatabaseService({ db: { image: "postgres:17", environment: { POSTGRES_USER: "shop" } } });
  assert.deepEqual(choice, { service: "db", user: "shop", database: "shop" });
});

test("erkennt die ueblichen Postgres-Abkoemmlinge", () => {
  assert.equal(pickDatabaseService({ gis: { image: "postgis/postgis:16-3.4" } })?.service, "gis");
  assert.equal(pickDatabaseService({ ts: { image: "timescale/timescaledb:latest-pg16" } })?.service, "ts");
  assert.equal(pickDatabaseService({ db: { image: "docker.io/library/postgres" } })?.service, "db");
});

test("haelt einen Postgres-CLIENT nicht fuer die Datenbank", () => {
  assert.equal(pickDatabaseService({ tools: { image: "myrepo/postgres-client:1" } }), null);
});

test("kein Datenbank-Dienst: null statt Fehlgriff", () => {
  assert.equal(pickDatabaseService({ frontend: { image: "nginx:alpine" }, api: {} }), null);
});
