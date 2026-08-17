# Businessplan Scrumy

## 1. Zusammenfassung

Scrumy ist das interne Betriebssystem einer KI-nativen Softwareberatung. Das
Unternehmen entwickelt individuelle Unternehmenssoftware und übernimmt deren
dauerhafte Pflege, Weiterentwicklung und technischen Betrieb. Kunden arbeiten
dabei wie Stakeholder mit einem festen Entwicklungsteam: Sie melden Fehler,
beauftragen Funktionen und stellen fachliche Fragen über ein Kundenportal,
Jira, E-Mail oder weitere Connectoren.

Intern werden diese Aufgaben von spezialisierten Software-Agenten bearbeitet.
Sie übernehmen Product Management, Planung, Backend- und Frontend-Entwicklung,
Qualitätssicherung, Review und DevOps. Menschliche Mitarbeiter beaufsichtigen
das Gesamtsystem, treffen kritische Entscheidungen und tragen die vertraglich
vereinbarte Dienstleistungsverantwortung.

Der Kunde erhält den vollständigen Quellcode in einem eigenen oder gemeinsam
verwalteten Git-Repository. Die langfristige Kundenbindung entsteht somit nicht
durch eine technische Zugangssperre, sondern durch kontinuierlichen Service,
gesammelten Projektkontext, schnelle Umsetzung und zuverlässigen Betrieb.

Das Geschäftsmodell kombiniert eine fünfstellige Initialgebühr mit monatlichen
Grundgebühren ab 1.000 Euro pro Projekt. Enthaltene Nutzung wird begrenzt;
zusätzliche Kapazität, Hosting, Service-Level, Zertifizierungen und besondere
Compliance-Anforderungen werden separat berechnet. Dadurch entstehen planbare,
wiederkehrende Erlöse bei kontrollierbaren variablen Kosten.

## 2. Problemstellung

Viele kleine und mittlere Unternehmen benötigen Software, die ihre individuellen
Prozesse abbildet. Bestehende Alternativen sind häufig unbefriedigend:

- Standardsoftware verlangt hohe Lizenzgebühren und zwingt Unternehmen, ihre
  Abläufe an das Produkt anzupassen.
- Klassische Individualentwicklung verursacht hohe Projektkosten und endet oft
  mit einer schwer planbaren Wartungsphase.
- Interne Entwicklungsteams sind teuer, schwer aufzubauen und für kleinere
  Unternehmen häufig nicht dauerhaft auszulasten.
- Klassische Beratungen skalieren überwiegend über zusätzliche Mitarbeiter.
  Mit jedem abgeschlossenen Projekt wächst zugleich die Pflegeverpflichtung.
- Wissen geht durch Personalwechsel oder das Ende eines Projektteams verloren.

Der größte Engpass ist daher nicht allein die erstmalige Entwicklung, sondern
die zuverlässige Pflege und Weiterentwicklung über den gesamten Lebenszyklus.

## 3. Lösung und Leistungsversprechen

Scrumy macht individuelle Unternehmenssoftware als dauerhaft betreuten Service
verfügbar. Das Leistungsversprechen lautet:

> Individuelle Software für die Abläufe des Kunden – mit einem dauerhaft
> verfügbaren Team für Entwicklung, Pflege und Weiterentwicklung.

Der Kunde kann insbesondere:

- neue Funktionen und Integrationen beauftragen,
- Bugs und betriebliche Probleme melden,
- Prioritäten setzen und Anforderungen präzisieren,
- fachliche oder technische Fragen an das Team stellen,
- Bearbeitungsstände und Releases verfolgen,
- Entscheidungen und kritische Änderungen freigeben.

Scrumy übersetzt die Kommunikation in einen kontrollierten Entwicklungsprozess:

1. Ein Support-Agent nimmt die Anfrage auf und klassifiziert sie.
2. Ein Product-Owner-Agent klärt Anforderungen und erzeugt priorisierte Tickets.
3. Planning- und Coding-Agenten planen und implementieren die Änderung.
4. QA- und Review-Agenten prüfen Ergebnis, Tests und Änderungen.
5. Kritische oder unklare Fälle werden einem Menschen beziehungsweise dem
   Kunden zur Entscheidung vorgelegt.
6. Nach Freigabe wird die Änderung zusammengeführt und ausgeliefert.
7. Status und Ergebnis werden über den ursprünglichen Kundenkanal zurückgemeldet.

## 4. Produkt

Scrumy ist zunächst kein separat verkauftes SaaS-Produkt, sondern die interne
Produktions- und Steuerungsplattform der Beratung. Sie verwaltet:

- Kundenorganisationen und Softwareprojekte,
- Anforderungen, Konzepte, Tickets und Sprints,
- spezialisierte Agenten und deren Modellprofile,
- Kundenanfragen und externe Connectoren,
- Git-Repositories, Commits und Änderungen,
- Freigaben, Rückfragen und verbindliche Beschlüsse,
- Modellaufrufe, Laufzeiten, Kosten und Fehler,
- Aktivitäten und technische Nachweise.

### Kundenzugang

Kunden können über mehrere Kanäle teilnehmen:

- eigenes Kundenportal,
- Jira-Connector,
- E-Mail oder Support-Client,
- perspektivisch Microsoft Teams, Slack oder weitere Systeme.

Alle Kanäle münden in denselben Support- und Entwicklungsprozess. Dadurch bleibt
der Projektkontext unabhängig vom Eingangskanal vollständig erhalten.

### Eigentum und Git-Strategie

Die Agenten arbeiten in einem Git-Repository, auf das der Kunde Zugriff hat oder
das ihm gehört. Änderungen erfolgen nachvollziehbar über Branches, Commits,
Tests und Pull Requests. Der Kunde besitzt beziehungsweise erhält den Quellcode
und kann grundsätzlich zu einem anderen Dienstleister wechseln.

Die Bindung an Scrumy ist ein Service-Lock-in: Sie entsteht durch tiefes
Prozesswissen, dokumentierte Entscheidungen, kurze Reaktionszeiten und die
laufende Betreuung, nicht durch das Zurückhalten von Code oder Daten.

## 5. Zielkunden und Markteintritt

Die primäre Zielgruppe sind kleine und mittlere Unternehmen, die einen relevanten
Digitalisierungsbedarf besitzen, aber kein vollständiges eigenes Softwareteam
aufbauen möchten. Besonders geeignet sind Unternehmen mit:

- individuellen Kern- und Unterstützungsprozessen,
- manuellen Abläufen und Medienbrüchen,
- Excel-, E-Mail- oder Insellösungen,
- hohen Lizenzkosten für unpassende Standardsoftware,
- wiederkehrendem Änderungs- und Integrationsbedarf.

Geeignete erste Anwendungsfälle sind interne Verwaltungsanwendungen,
Workflow- und Freigabesysteme, Kundenportale, CRM- und Auftragsprozesse,
Reporting, Datenintegration und branchenspezifische Fachanwendungen.

Der Markteintritt erfolgt über die Gründung und Positionierung einer
Softwareberatung. Scrumy wird intern eingesetzt; verkauft werden Ergebnis,
Kontinuität und Verantwortung. Referenzprojekte und direkte Vertriebsarbeit des
Gründers dienen zunächst als wichtigste Akquisitionskanäle.

## 6. Wettbewerb und Differenzierung

Scrumy positioniert sich zwischen Standardsoftware, klassischer Beratung,
Freelancern und internen Entwicklungsteams.

Wesentliche Differenzierungsmerkmale sind:

- individuelle Software ohne dauerhafte interne Personalbindung des Kunden,
- kontinuierlich verfügbares Projektwissen,
- Pflege und Weiterentwicklung als Bestandteil des Geschäftsmodells,
- direkte Kommunikation wie mit einem festen Entwicklungsteam,
- nachweisbarer Entwicklungsprozess mit Git-Historie und Audit-Trail,
- niedrigere und besser skalierbare Produktionskosten durch Agenten,
- Quellcodezugang ohne künstlichen technischen Lock-in,
- ein Ansprechpartner für Konzeption, Entwicklung und Lebenszyklus.

Der langfristige Wettbewerbsvorteil entsteht aus der Orchestrierungsplattform,
realen Projektdaten, wiederverwendbaren Abläufen, Connectoren, Qualitätsregeln
und dem über Jahre aufgebauten Kundenkontext.

## 7. Erlösmodell

### Initiale Projektgebühr

Für jedes neue Projekt wird eine fünfstellige Setup- und Initialisierungsgebühr
berechnet. Der konkrete Preis richtet sich nach Umfang und Risiko. Sie umfasst
typischerweise:

- Discovery und Prozessaufnahme,
- Konzeption und initiale Anforderungen,
- Architektur und Datenmodell,
- Repository, Entwicklungsumgebung und CI/CD-Grundlage,
- Einrichtung der Agenten und Connectoren,
- erste produktive Ausbaustufe,
- Deployment- und Betriebskonzept.

Als erste Preishypothese wird ein Korridor von 15.000 bis 50.000 Euro angesetzt.
Größere Migrationen oder komplexe Integrationen werden individuell angeboten.

### Monatliche Gebühren

Die monatliche Grundgebühr beginnt bei 1.000 Euro je Projekt. Sie finanziert die
dauerhafte Verfügbarkeit, Grundwartung und eine begrenzte Nutzung. Zur sauberen
Segmentierung sind mehrere Serviceklassen vorgesehen:

| Tarif | Monatspreis (Hypothese) | Leistungsschwerpunkt |
| --- | ---: | --- |
| Maintain | ab 1.000 Euro | Pflege, Updates und kleine Änderungen |
| Develop | ab 2.500 Euro | kontinuierliche Weiterentwicklung |
| Business Critical | ab 5.000 Euro | Priorität, erweiterte Kontrollen und SLA |

### Verbrauch und Zusatzleistungen

Jeder Tarif enthält ein begrenztes Nutzungskontingent. Intern wird dieses über
Modell-Tokens, Modellklasse, Rechenzeit, Infrastruktur und menschlichen Aufwand
kalkuliert. Gegenüber Kunden kann es als transparentes Team- oder
Entwicklungskontingent ausgewiesen werden.

Zusätzlich berechnet werden insbesondere:

- weitere Nutzungs- oder Kapazitätspakete,
- Hosting und Drittanbietergebühren,
- priorisierte oder beschleunigte Bearbeitung,
- erhöhte Verfügbarkeit und Rufbereitschaft,
- Datenmigrationen und außergewöhnliche Integrationen,
- Sicherheitsprüfungen und externe Audits,
- formale Zertifizierung und laufende Rezertifizierung,
- Exit-Unterstützung und strukturierte Projektübergabe.

Verträge sollen Mindestlaufzeiten und regelmäßige Preisanpassungen enthalten.
Größere Vorhaben werden vor Ausführung geschätzt und freigegeben.

## 8. Kostenstruktur und Margenlogik

Die wichtigsten variablen Kosten sind:

- LLM- und Rechenkosten,
- Hosting, Build- und Testinfrastruktur,
- menschliche Überwachung und Freigabe,
- Support- und Incident-Aufwand,
- externe Dienste und Connectoren.

Fixkosten entstehen vor allem durch Produktentwicklung, Vertrieb, Verwaltung,
Versicherungen und den Aufbau standardisierter Betriebsprozesse.

Das Modell ist erfolgreich, wenn Umsatz und Zahl der Kundenprojekte schneller
wachsen als der menschliche Betreuungsaufwand. Token- und Nutzungslimits
verhindern, dass intensive Einzelkunden die Deckungsbeiträge anderer Kunden
aufzehren. Wiederverwendbare Komponenten und automatisierte Qualitäts- und
Betriebsprozesse sollen die Grenzkosten jedes weiteren Projekts senken.

### Beispielrechnung für ein Projekt

Ein beispielhaftes Projekt mit 25.000 Euro Initialgebühr, 2.500 Euro monatlicher
Gebühr und einer Laufzeit von 24 Monaten erzeugt 85.000 Euro Umsatz vor
Zusatznutzung. Die Profitabilität wird anhand der tatsächlich verbrauchten
Modell-, Infrastruktur- und Betreuungsressourcen gemessen. Diese Rechnung dient
nur als Planungshypothese und muss mit Pilotkundendaten validiert werden.

## 9. Vertrieb und Kundenbindung

Der Vertrieb beginnt beratungsnah und problemorientiert. Verkauft wird nicht
die Zahl eingesetzter Agenten, sondern die dauerhaft verfügbare Fähigkeit, einen
Geschäftsprozess in Software umzusetzen und weiterzuentwickeln.

Der typische Vertriebsprozess ist:

1. Analyse eines konkreten betrieblichen Problems.
2. Bezahlte Discovery oder klar abgegrenztes Pilotprojekt.
3. Angebot für Initialisierung und erste produktive Ausbaustufe.
4. Einführung mit frühem messbarem Nutzen.
5. Übergang in den laufenden Pflege- und Weiterentwicklungsvertrag.
6. Schrittweiser Ausbau um weitere Prozesse und Module.

Die Kundenbindung entsteht durch gute Ergebnisse, gespeicherten Kontext,
verlässliche Kommunikation und kontinuierliche Verbesserung. Code- und
Datenzugang bleiben erhalten, um Vertrauen und geringe Einstiegshürden zu
gewährleisten.

## 10. Betrieb, Qualität und Verantwortung

Scrumy muss über die Codeerzeugung hinaus den vollständigen Lebenszyklus einer
Anwendung abdecken. Dazu gehören:

- automatisierte Builds, Tests und Qualitätskontrollen,
- getrennte Entwicklungs-, Test- und Produktionsumgebungen,
- Branch- und Pull-Request-Prozesse,
- Monitoring, Backups und Wiederherstellung,
- kontrollierte Deployments und Rollbacks,
- Abhängigkeits- und Sicherheitsupdates,
- dokumentierte Entscheidungen und Freigaben,
- Eskalation unklarer oder risikoreicher Änderungen.

Kunden entscheiden im Rahmen der vertraglichen Vereinbarungen über Einsatz und
fachliche Freigabe ihrer Software. Haftung, Abnahme, Mitwirkungspflichten,
Gewährleistung, Datenschutz und Haftungsgrenzen müssen vor Marktstart juristisch
geprüft und vertraglich belastbar geregelt werden. Formale Zertifizierungen sind
nicht Bestandteil der Standardleistung und werden separat beauftragt.

## 11. Risiken und Gegenmaßnahmen

### Unkontrollierte Nutzung

Sehr aktive Kunden könnten variable Kosten stark erhöhen. Gegenmaßnahmen sind
Nutzungslimits, Zusatzpakete, Schätzungen und Freigaben vor großen Änderungen.

### Fehlerhafte oder schwer wartbare Agentenergebnisse

Gegenmaßnahmen sind automatisierte Tests, QA- und Review-Schritte,
Architekturregeln, Risiko-Schwellen sowie menschliche Freigaben.

### Technologische Vielfalt

Das Angebot bleibt fachlich offen, nutzt aber soweit möglich standardisierte
Entwicklungs-, Test-, Deployment- und Monitoringverfahren. Abweichende
Betriebsmodelle werden eingepreist.

### Datenschutz und Mandantentrennung

Erforderlich sind strikt getrennte Kundenkontexte, rollenbasierte Zugriffe,
Secret-Management, Protokollierung, Löschkonzepte und geeignete Verträge zur
Auftragsverarbeitung.

### Abhängigkeit von Modellanbietern

Mehrere LLM-Profile, lokale Modelle und austauschbare Provider reduzieren
technische und wirtschaftliche Abhängigkeiten.

### Haftungs- und Betriebsrisiken

Risiken werden durch klare Leistungsbeschreibungen, Abnahmeverfahren,
Haftungsgrenzen, Versicherungen, Sicherheitsprozesse und gesondert vergütete
Zertifizierungen kontrolliert.

## 12. Umsetzungsplan

### Phase 1: Interne Produktionsreife

- Agenten-Orchestrierung und Klärungsprozesse stabilisieren
- Builds und Tests in Kunden-Workspaces ausführen
- Branch-, Pull-Request- und Remote-Push-Prozess etablieren
- Kosten- und Tokenmessung pro Projekt einführen
- Mandantentrennung, Authentifizierung und Secret-Management umsetzen

### Phase 2: Pilotkunden

- ein bis drei klar abgegrenzte Kundenprojekte gewinnen
- Setup- und Monatsgebühren real validieren
- menschlichen Betreuungsaufwand vollständig erfassen
- Kundenkommunikation zunächst über Portal und einen Kern-Connector abbilden
- Betrieb, Updates und Erweiterungen über mehrere Monate testen

### Phase 3: Standardisierung

- wiederkehrende Architekturen und Komponenten paketieren
- Deployment, Monitoring und Backups automatisieren
- Serviceklassen und SLA operationalisieren
- Support-, Freigabe- und Eskalationsprozesse standardisieren
- Referenzen und messbare Kundenergebnisse für den Vertrieb nutzen

### Phase 4: Skalierung

- Vertrieb und Partnerkanäle ausbauen
- weitere Connectoren ergänzen
- menschliche Aufsicht nach Risikoklassen organisieren
- zusätzliche Branchen und Betriebsmodelle kontrolliert erschließen
- optional prüfen, ob Teile von Scrumy später an Partner lizenziert werden

## 13. Kennzahlen

Die zentrale Skalierungskennzahl ist:

> Menschliche Betreuungsstunden pro aktivem Kundenprojekt und Monat.

Weitere Steuerungsgrößen sind:

- monatlich wiederkehrender Umsatz,
- Deckungsbeitrag pro Projekt,
- LLM- und Infrastrukturkosten pro Projekt,
- Projekte pro menschlichem Verantwortlichen,
- Anteil autonom abgeschlossener Aufgaben,
- Durchlaufzeit von Anfrage bis Deployment,
- Fehler-, Eskalations- und Rollbackquote,
- Nutzung und Zukauf zusätzlicher Kapazität,
- Vertragsverlängerungs- und Kündigungsquote,
- Umsatzanteil aus Pflege und Weiterentwicklung.

## 14. Meilensteine der ersten 24 Monate

1. Produktionsreifer Git-, Test- und Deploymentprozess
2. Rechtliche Vertragsgrundlagen und Versicherungen
3. Erster zahlender Pilotkunde
4. Drei aktive Kundenprojekte mit positivem Deckungsbeitrag
5. Nachweis eines stabilen Wartungsbetriebs über mindestens sechs Monate
6. Standardisierte Preis- und Servicepakete
7. Zehn aktive Projekte mit dokumentierter Betreuungseffizienz
8. Entscheidung über Teamaufbau, Branchenfokus und weitere Skalierung

## 15. Fazit

Scrumy verbindet die Zahlungsbereitschaft und Kundenbeziehung einer Beratung mit
der potenziell skalierbaren Kostenstruktur einer Softwareplattform. Das
Unternehmen ermöglicht Kunden individuelle Software, ohne dass diese selbst ein
dauerhaftes Entwicklungsteam aufbauen müssen. Wiederkehrende Pflege und
Weiterentwicklung bilden den Kern des langfristigen Geschäftsverhältnisses.

Der wirtschaftliche Erfolg hängt davon ab, ob Scrumy viele aktive Projekte mit
geringem menschlichem Betreuungsaufwand zuverlässig betreiben kann. Die
Geschäftshypothese sollte deshalb nicht primär anhand erzeugter Code-Mengen,
sondern anhand von Deckungsbeitrag, Softwarequalität und Betreuungsstunden pro
Projekt validiert werden.
