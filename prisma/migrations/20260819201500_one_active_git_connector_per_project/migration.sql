-- Ein Projekt hat genau ein Arbeits-Repository. Mehrere historische oder
-- inaktive Git-Connectoren bleiben erlaubt, aber nur einer darf die aktive
-- Branch-/Credential-Konfiguration liefern. Der partielle Index erzwingt das
-- auch bei gleichzeitigen Requests, nicht nur in der Server-Action.
CREATE UNIQUE INDEX "connectors_one_active_git_per_project"
ON "connectors" ("projectId")
WHERE "provider" = 'GIT'
  AND "status" = 'ACTIVE'
  AND "projectId" IS NOT NULL;
