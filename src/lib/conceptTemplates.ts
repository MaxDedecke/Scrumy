// Konzept-Vorlagen: fertige Entwürfe für die häufigste Anfrage im Beratungs-
// geschäft – "baut mir ein eigenes <teures SaaS-Produkt>". Jede Vorlage füllt
// das Konzept-Freitextfeld des Projekts vor und dient als Gesprächsgrundlage,
// nicht als fertiges Konzept.
//
// Die Preisangaben sind bewusst grobe Größenordnungen (Listenpreise ändern
// sich laufend und hängen an Staffeln/Verhandlung) – sie sollen den Leidens-
// druck einordnen, nicht ein Angebot begründen. Vor Angebotsabgabe prüfen.

export type ConceptTemplate = {
  id: string;
  /** Das abgelöste SaaS-Produkt, z.B. "Jira". */
  name: string;
  category: string;
  /** Was stattdessen gebaut wird, z.B. "Ticket- & Sprint-Verwaltung". */
  what: string;
  /** Grobe Preis-Größenordnung des Originals. */
  priceNote: string;
  pain: string;
  goal: string;
  modules: string[];
  nonGoals: string[];
  integrations: string[];
  openQuestions: string[];
};

export const CONCEPT_TEMPLATE_CATEGORIES = [
  "Tabellen & Daten",
  "Projekt & Aufgaben",
  "Wissen & Zusammenarbeit",
  "CRM & Vertrieb",
  "Support & Service",
  "ERP & Finanzen",
  "HR & Personal",
  "Kommunikation & Termine",
  "Marketing & Analytics",
  "Shop & Verträge",
  "Automatisierung",
] as const;

export const CONCEPT_TEMPLATES: ConceptTemplate[] = [
  // ---------------------------------------------------------------- Tabellen
  {
    id: "excel",
    name: "Excel",
    category: "Tabellen & Daten",
    what: "Fachanwendung für geschäftskritische Tabellen",
    priceNote: "ca. 12 €/Nutzer/Monat (Microsoft 365 Business)",
    pain: "Die eigentlichen Kosten sind nicht die Lizenz, sondern die gewachsenen Tabellen: Formeln, die niemand mehr versteht, parallele Kopien auf Netzlaufwerken, keine Historie, kein Mehrbenutzerbetrieb, kein Rechtekonzept.",
    goal: "Die geschäftskritischen Tabellen durch eine Webanwendung mit festem Datenmodell, Validierung, Historie und Rollen ersetzen. Excel bleibt für Ad-hoc-Auswertungen, ist aber nicht mehr das führende System.",
    modules: [
      "Datenmodell für die abzulösenden Tabellen (Stammdaten, Bewegungsdaten getrennt)",
      "Erfassungsmasken mit Pflichtfeldern und Plausibilitätsprüfungen",
      "Rollen und Rechte je Bereich (lesen / erfassen / freigeben)",
      "Änderungshistorie mit Nutzer und Zeitstempel je Datensatz",
      "Auswertungen und Export nach Excel/CSV für den Weiterversand",
    ],
    nonGoals: [
      "Kein allgemeiner Formeleditor – Rechenlogik wird fachlich implementiert, nicht vom Nutzer geschrieben",
      "Kein Ersatz für Ad-hoc-Analysen einzelner Mitarbeiter",
    ],
    integrations: [
      "Import der bestehenden Arbeitsmappen als Erstbefüllung",
      "Export nach Excel/CSV für Berichte an Dritte",
    ],
    openQuestions: [
      "Welche Tabellen sind wirklich geschäftskritisch (meist 3–5 von vielen)?",
      "Welche Formeln enthalten Fachlogik, die dokumentiert werden muss?",
    ],
  },
  {
    id: "airtable",
    name: "Airtable",
    category: "Tabellen & Daten",
    what: "Eigene Datenbank mit Tabellenoberfläche",
    priceNote: "ca. 20–45 $/Nutzer/Monat (Team/Business)",
    pain: "Pro Nutzer bezahlt, obwohl viele nur lesen. Datensatz-Limits pro Base zwingen zu Workarounds, und die Daten liegen außerhalb der eigenen Infrastruktur.",
    goal: "Die genutzten Bases als eigene Anwendung nachbauen – mit denselben Ansichten, aber ohne Nutzer- und Datensatzgrenzen.",
    modules: [
      "Tabellen mit typisierten Feldern und Verknüpfungen zwischen Datensätzen",
      "Mehrere Ansichten je Tabelle (Liste, Kanban, Kalender)",
      "Filter, Sortierung und gespeicherte Sichten je Nutzer",
      "Formularansicht für die Erfassung durch Externe",
      "Automatisierungen bei Statuswechsel (Benachrichtigung, Folgeeintrag)",
    ],
    nonGoals: [
      "Kein generischer Base-Builder für beliebige neue Tabellen durch Endnutzer",
      "Kein Marketplace für Erweiterungen",
    ],
    integrations: [
      "Datenübernahme per CSV-Export aus den bestehenden Bases",
      "REST-Schnittstelle für angebundene Tools",
    ],
    openQuestions: [
      "Welche Bases und Ansichten werden tatsächlich täglich genutzt?",
      "Wer erfasst über Formulare – interne oder externe Nutzer?",
    ],
  },
  {
    id: "smartsheet",
    name: "Smartsheet",
    category: "Tabellen & Daten",
    what: "Projekt-Tabellen mit Terminplan",
    priceNote: "ca. 9–32 $/Nutzer/Monat zzgl. Enterprise-Aufschläge",
    pain: "Lizenzkosten steigen mit jedem Mitarbeiter, der auch nur einen Termin eintragen soll. Freigabe an Externe kostet zusätzlich.",
    goal: "Termin- und Ressourcenplanung als eigene Anwendung, bei der Lesezugriff und Erfassung durch Externe nichts extra kosten.",
    modules: [
      "Vorgangsliste mit Start-/Endterminen und Abhängigkeiten",
      "Gantt-Ansicht mit kritischem Pfad",
      "Ressourcenzuordnung und Auslastung je Mitarbeiter",
      "Statusmeldungen und Meilenstein-Freigaben",
      "Berichte über mehrere Projekte hinweg",
    ],
    nonGoals: [
      "Keine vollständige Ressourcenkostenrechnung",
      "Kein eigenes Formularsystem – separat abgestimmt",
    ],
    integrations: [
      "Kalender-Export (ICS) für Termine",
      "Excel-/CSV-Import bestehender Pläne",
    ],
    openQuestions: [
      "Wie viele Projekte laufen parallel, wie viele Vorgänge je Projekt?",
      "Werden Abhängigkeiten wirklich gepflegt oder nur Termine?",
    ],
  },

  // ------------------------------------------------------- Projekt & Aufgaben
  {
    id: "jira",
    name: "Jira",
    category: "Projekt & Aufgaben",
    what: "Ticket- & Sprint-Verwaltung",
    priceNote: "ca. 8–16 $/Nutzer/Monat (Standard/Premium), Staffeln ab 100 Nutzern",
    pain: "Die Konfiguration ist über Jahre gewachsen: Workflows, Screens und Felder, die niemand mehr abschalten will. Gleichzeitig zahlt jeder Nutzer voll, auch wer nur Tickets meldet.",
    goal: "Ein schlankes Ticketsystem mit genau den Feldern und Übergängen, die das Team wirklich nutzt – Melden ist für alle kostenlos.",
    modules: [
      "Tickets mit Typ, Priorität, Zuständigkeit und Statusfluss",
      "Backlog und Sprints mit Kapazitätsplanung",
      "Board-Ansicht je Team mit Spalten entlang des Workflows",
      "Kommentare, Anhänge und vollständige Änderungshistorie",
      "Auswertungen: Durchlaufzeit, offene kritische Tickets, Sprint-Abschluss",
    ],
    nonGoals: [
      "Kein frei konfigurierbarer Workflow-Editor – Workflows werden fachlich festgelegt",
      "Keine Nachbildung der Jira-Marketplace-Plugins",
    ],
    integrations: [
      "Git-Anbindung: Commit/Branch referenziert die Ticketnummer",
      "Import bestehender Vorgänge inkl. Kommentaren",
    ],
    openQuestions: [
      "Welche Ticket-Typen und Statusübergänge werden tatsächlich gelebt?",
      "Wie viele reine Melder gibt es gegenüber aktiven Bearbeitern?",
    ],
  },
  {
    id: "asana",
    name: "Asana",
    category: "Projekt & Aufgaben",
    what: "Aufgaben- & Projektplanung",
    priceNote: "ca. 11–25 €/Nutzer/Monat (Starter/Advanced)",
    pain: "Wichtige Funktionen wie Zeitachse, Regeln und Portfolios liegen in den teuren Stufen – der Preis pro Kopf verdoppelt sich für zwei Features.",
    goal: "Aufgabenverwaltung mit Zeitachse und Automatisierungsregeln ohne Stufenlogik: alle Funktionen für alle Nutzer.",
    modules: [
      "Projekte mit Aufgaben, Teilaufgaben und Fälligkeiten",
      "Zuständigkeiten und persönliche Aufgabenliste je Mitarbeiter",
      "Zeitachse über Projekte hinweg (Portfolio-Sicht)",
      "Regeln: bei Statuswechsel zuweisen, benachrichtigen, verschieben",
      "Auslastungsübersicht je Mitarbeiter",
    ],
    nonGoals: [
      "Kein Zielsystem (OKR) in der ersten Ausbaustufe",
      "Keine Zeiterfassung – separat zu entscheiden",
    ],
    integrations: [
      "Kalender-Abo (ICS) für Fälligkeiten",
      "E-Mail-Eingang für neue Aufgaben",
    ],
    openQuestions: [
      "Werden Portfolios/Zeitachsen wirklich genutzt oder nur Listen?",
      "Welche Regeln laufen heute automatisch?",
    ],
  },
  {
    id: "monday",
    name: "Monday.com",
    category: "Projekt & Aufgaben",
    what: "Arbeits- & Ressourcenplanung",
    priceNote: "ca. 9–19 €/Nutzer/Monat, Abrechnung in Sitz-Paketen",
    pain: "Sitz-Pakete zwingen zum Kauf in Dreierschritten, und Automatisierungen sind pro Monat kontingentiert – wer viel automatisiert, zahlt die nächste Stufe.",
    goal: "Boards mit Automatisierungen ohne Kontingent und ohne Sitz-Pakete – bezahlt wird die Entwicklung, nicht die Nutzung.",
    modules: [
      "Boards mit frei definierten Spaltentypen (Status, Datum, Person, Zahl)",
      "Gruppierung und mehrere Ansichten je Board",
      "Automatisierungen ohne Mengenbegrenzung",
      "Dashboards über mehrere Boards",
      "Gastzugang für Kunden mit eingeschränkter Sicht",
    ],
    nonGoals: [
      "Kein visueller Automatisierungs-Baukasten für Endnutzer",
      "Keine Nachbildung aller Spaltentypen – nur die genutzten",
    ],
    integrations: [
      "E-Mail-Benachrichtigungen",
      "CSV-Import der bestehenden Boards",
    ],
    openQuestions: [
      "Wie viele Automatisierungen laufen heute und was tun sie?",
      "Wie viele Gäste/Kunden greifen zu?",
    ],
  },
  {
    id: "linear",
    name: "Linear",
    category: "Projekt & Aufgaben",
    what: "Issue-Tracking für Entwicklungsteams",
    priceNote: "ca. 8–14 $/Nutzer/Monat (Basic/Business)",
    pain: "Für kleine Entwicklungsteams gut bezahlbar, aber die Daten liegen extern – bei Kundenprojekten mit Geheimhaltungsauflagen ein Problem.",
    goal: "Schlankes, schnelles Issue-Tracking im eigenen Betrieb, mit den Arbeitsabläufen des Teams und ohne Datenabfluss.",
    modules: [
      "Issues mit Zyklen (Cycles) und Projekten",
      "Tastaturgetriebene Bedienung für schnelle Erfassung",
      "Automatischer Statuswechsel über Git-Branches und Pull Requests",
      "Roadmap-Sicht über Projekte",
      "Auswertung abgeschlossener Arbeit je Zyklus",
    ],
    nonGoals: [
      "Keine Kundenkommunikation im Tool – dafür ist das Support-Postfach zuständig",
      "Kein Dokumentenmanagement",
    ],
    integrations: [
      "Git-Anbindung (Branch- und PR-Referenzen)",
      "Import per API-Export",
    ],
    openQuestions: [
      "Arbeitet das Team in Zyklen oder kontinuierlich?",
      "Welche Geheimhaltungsauflagen gelten für Kundendaten?",
    ],
  },

  // -------------------------------------------------- Wissen & Zusammenarbeit
  {
    id: "confluence",
    name: "Confluence",
    category: "Wissen & Zusammenarbeit",
    what: "Firmenwiki",
    priceNote: "ca. 6–11 $/Nutzer/Monat, Data Center vierstellig pro Jahr",
    pain: "Jeder Mitarbeiter braucht eine Lizenz, um überhaupt lesen zu können – Wissen wird dadurch künstlich verknappt. Die Suche findet mit wachsendem Bestand immer schlechter.",
    goal: "Ein Wiki, in dem alle lesen dürfen, mit einer Suche, die auch bei zehntausenden Seiten brauchbar bleibt.",
    modules: [
      "Seitenbaum mit Bereichen und Berechtigungen",
      "Editor mit Versionsvergleich und Wiederherstellung",
      "Volltextsuche inkl. Anhänge",
      "Kommentare und Freigabe-/Review-Vermerke je Seite",
      "Vorlagen für wiederkehrende Dokumenttypen (Protokoll, Entscheidung)",
    ],
    nonGoals: [
      "Kein Makro-System wie in Confluence",
      "Keine Echtzeit-Mehrbenutzerbearbeitung in Stufe 1",
    ],
    integrations: [
      "Verlinkung von Tickets aus dem Projektsystem",
      "Import bestehender Seiten inkl. Anhänge",
    ],
    openQuestions: [
      "Wie viele Seiten und Anhänge müssen übernommen werden?",
      "Welche Bereiche sind vertraulich, welche für alle lesbar?",
    ],
  },
  {
    id: "notion",
    name: "Notion",
    category: "Wissen & Zusammenarbeit",
    what: "Wissens- & Projektarbeitsplatz",
    priceNote: "ca. 10–18 $/Nutzer/Monat zzgl. KI-Zusatz",
    pain: "Sehr flexibel, aber genau deshalb entstehen parallele Strukturen ohne verbindliches Datenmodell. Die KI-Funktionen kosten pro Kopf zusätzlich.",
    goal: "Die tatsächlich etablierten Strukturen in eine Anwendung mit festem Modell überführen – Dokumente und Datensätze sauber getrennt.",
    modules: [
      "Dokumente mit Blockstruktur und Verlinkung",
      "Datenbanksichten (Tabelle, Board, Kalender) auf strukturierte Datensätze",
      "Rechte je Bereich und je Dokument",
      "Volltextsuche über Dokumente und Datensätze",
      "Vorlagen für wiederkehrende Seitentypen",
    ],
    nonGoals: [
      "Keine beliebige Verschachtelung von Datenbanken in Datenbanken",
      "Keine KI-Funktionen in der ersten Ausbaustufe",
    ],
    integrations: [
      "Markdown-/CSV-Import des bestehenden Workspace",
      "Verlinkung ins Ticketsystem",
    ],
    openQuestions: [
      "Welche Datenbanken sind führend, welche nur Notizen?",
      "Wer darf strukturell ändern, wer nur Inhalte pflegen?",
    ],
  },
  {
    id: "miro",
    name: "Miro",
    category: "Wissen & Zusammenarbeit",
    what: "Whiteboard für Workshops",
    priceNote: "ca. 8–16 $/Nutzer/Monat, Gastzugriff eingeschränkt",
    pain: "Workshops mit Kunden scheitern an Lizenzen für Externe, und Boards altern schnell zu unauffindbaren Bildtapeten.",
    goal: "Ein Whiteboard für moderierte Workshops, bei dem Externe per Link teilnehmen und Ergebnisse strukturiert übernommen werden.",
    modules: [
      "Board mit Notizzetteln, Formen, Verbindungen und Rahmen",
      "Gleichzeitige Bearbeitung mit sichtbaren Cursorn",
      "Gastzugang per Einladungslink ohne Konto",
      "Vorlagen für Retrospektive, Story Mapping, Risikomatrix",
      "Export der Ergebnisse als strukturierte Liste (nicht nur als Bild)",
    ],
    nonGoals: [
      "Kein Diagramm-Editor mit Fachnotation (BPMN/UML)",
      "Keine Videokonferenz im Board",
    ],
    integrations: [
      "Überführung von Notizzetteln in Anforderungen/Tickets",
      "PDF-/Bild-Export für Protokolle",
    ],
    openQuestions: [
      "Wie viele Teilnehmer gleichzeitig, davon wie viele extern?",
      "Welche Workshop-Formate werden regelmäßig gefahren?",
    ],
  },

  // ------------------------------------------------------------ CRM & Vertrieb
  {
    id: "salesforce",
    name: "Salesforce",
    category: "CRM & Vertrieb",
    what: "CRM für Kunden und Vertrieb",
    priceNote: "ca. 25–165 €/Nutzer/Monat je Edition, dazu Einführungsprojekt",
    pain: "Der Lizenzpreis ist nur ein Teil: Anpassungen brauchen spezialisierte Berater, jede Erweiterung erhöht die Abhängigkeit. Für den tatsächlich genutzten Funktionsumfang ist der Preis kaum zu rechtfertigen.",
    goal: "Ein CRM mit genau den Objekten und Prozessen des Kunden – erweiterbar durch das eigene Agenten-Team statt durch externe Berater.",
    modules: [
      "Firmen, Kontakte und Beziehungen zwischen ihnen",
      "Verkaufschancen mit Phasen, Wahrscheinlichkeit und Prognose",
      "Aktivitäten: Anrufe, Termine, E-Mails am Datensatz",
      "Angebote mit Positionen und Freigabe-Workflow",
      "Auswertungen: Pipeline, Abschlussquote, Umsatz je Zeitraum",
    ],
    nonGoals: [
      "Kein Marketing-Automation-Modul in Stufe 1",
      "Keine Nachbildung des Salesforce-Rechtemodells in voller Tiefe",
    ],
    integrations: [
      "E-Mail-Anbindung zur Aktivitätserfassung",
      "Übernahme von Konten, Kontakten und offenen Chancen",
    ],
    openQuestions: [
      "Welche Felder und Objekte sind über die Jahre wirklich in Gebrauch?",
      "Welche Berichte gehen an die Geschäftsführung?",
    ],
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "CRM & Vertrieb",
    what: "CRM mit Marketing-Funktionen",
    priceNote: "Einstieg günstig, Professional-Stufen schnell 800–1.500 €/Monat",
    pain: "Der Einstieg ist billig, aber die benötigten Funktionen liegen in Professional/Enterprise – und die Kontaktstaffeln erhöhen den Preis mit jedem Marketing-Erfolg.",
    goal: "CRM und Kampagnenversand ohne Kontaktstaffel: wachsende Kontaktzahlen erhöhen die Kosten nicht.",
    modules: [
      "Kontakte und Firmen mit Lebenszyklus-Phasen",
      "Deal-Pipeline mit Phasen und Aufgaben",
      "E-Mail-Kampagnen mit Vorlagen und Versandlisten",
      "Formulare und Landingpages zur Lead-Erfassung",
      "Auswertung: Herkunft der Leads bis zum Abschluss",
    ],
    nonGoals: [
      "Kein Lead-Scoring per Modell in Stufe 1",
      "Kein Ticketsystem – dafür gibt es das Support-Postfach",
    ],
    integrations: [
      "Website-Formulare direkt ins CRM",
      "Versanddienstleister für E-Mail-Zustellung",
    ],
    openQuestions: [
      "Wie viele Kontakte sind es heute, wie schnell wachsen sie?",
      "Welche Automatisierungsstrecken laufen aktiv?",
    ],
  },
  {
    id: "pipedrive",
    name: "Pipedrive",
    category: "CRM & Vertrieb",
    what: "Vertriebspipeline",
    priceNote: "ca. 14–79 €/Nutzer/Monat je Stufe",
    pain: "Funktionen wie Projekte, Automatisierungen und Berichte sind über die Stufen verteilt; wer eine davon braucht, zahlt für alle.",
    goal: "Eine schlanke Pipeline mit genau den Automatisierungen des Vertriebsteams, ohne Stufenpolitik.",
    modules: [
      "Pipeline mit frei definierten Phasen und Drag-and-drop",
      "Aktivitäten mit Erinnerung je Deal",
      "Angebots- und Auftragsdokumente",
      "Automatische Folgeaufgaben bei Phasenwechsel",
      "Prognose und Abschlussquote je Vertriebler",
    ],
    nonGoals: [
      "Kein Telefonie-Modul",
      "Keine Rechnungsstellung – Schnittstelle zur Buchhaltung genügt",
    ],
    integrations: [
      "E-Mail-Synchronisierung",
      "Übergabe gewonnener Deals an die Buchhaltung",
    ],
    openQuestions: [
      "Wie viele Pipelines braucht der Vertrieb wirklich?",
      "Welche Berichte steuern die Vertriebssteuerung?",
    ],
  },

  // ----------------------------------------------------------- Support & Service
  {
    id: "zendesk",
    name: "Zendesk",
    category: "Support & Service",
    what: "Support-Ticketsystem",
    priceNote: "ca. 19–115 €/Agent/Monat je Suite-Stufe",
    pain: "Jeder Agent kostet monatlich, auch bei saisonalen Spitzen. Automatisierungen und SLA-Steuerung liegen in den oberen Stufen.",
    goal: "Ein Support-System mit SLA-Steuerung und Automatisierung, dessen Kosten nicht mit der Zahl der Agenten steigen.",
    modules: [
      "Ticket-Eingang aus E-Mail, Formular und Portal",
      "Automatische Zuordnung nach Kategorie und Priorität",
      "SLA-Fristen mit Eskalation bei Überschreitung",
      "Antwortvorlagen und interne Notizen",
      "Auswertung: Reaktionszeit, Lösungsquote, Wiedereröffnungen",
    ],
    nonGoals: [
      "Kein Telefonie-Kanal in Stufe 1",
      "Kein öffentliches Community-Forum",
    ],
    integrations: [
      "E-Mail-Postfach als Ticketquelle",
      "Übergabe an das Entwicklungs-Ticketsystem bei Bugs",
    ],
    openQuestions: [
      "Wie viele Anfragen pro Monat, welche Spitzenlast?",
      "Welche SLA-Zusagen bestehen vertraglich?",
    ],
  },
  {
    id: "intercom",
    name: "Intercom",
    category: "Support & Service",
    what: "Kundenchat & Self-Service",
    priceNote: "ca. 29–85 $/Sitz/Monat plus Abrechnung je gelöster KI-Konversation",
    pain: "Die Abrechnung pro gelöster Konversation macht die Kosten unplanbar – ausgerechnet Erfolg wird teuer.",
    goal: "Chat und Hilfe-Center im eigenen Betrieb, mit festen Kosten unabhängig vom Gesprächsvolumen.",
    modules: [
      "Chat-Widget für die Kundenanwendung",
      "Gesprächsverlauf je Kunde über alle Kanäle",
      "Hilfe-Center mit durchsuchbaren Artikeln",
      "Automatische Antwortvorschläge aus den Hilfeartikeln",
      "Weiterleitung an einen Menschen mit vollem Kontext",
    ],
    nonGoals: [
      "Keine Marketing-Kampagnen über den Chat",
      "Keine Produkt-Touren/Onboarding-Overlays",
    ],
    integrations: [
      "Anbindung an das Support-Postfach",
      "Kundenkontext aus dem CRM im Chatfenster",
    ],
    openQuestions: [
      "Wie viele Konversationen pro Monat laufen heute?",
      "Welcher Anteil ist mit Hilfeartikeln lösbar?",
    ],
  },

  // ------------------------------------------------------------ ERP & Finanzen
  {
    id: "sap-business-one",
    name: "SAP Business One",
    category: "ERP & Finanzen",
    what: "Warenwirtschaft & Auftragsabwicklung",
    priceNote: "ca. 1.500–3.000 € Lizenz je Nutzer plus rund 20 % Wartung jährlich",
    pain: "Hohe Einstiegsinvestition, jährliche Wartung und ein Partnermodell, in dem jede Anpassung extern beauftragt werden muss. Der Mittelständler nutzt einen Bruchteil des Umfangs.",
    goal: "Eine Warenwirtschaft, die exakt die Prozesse des Kunden abbildet – Artikel, Bestellung, Lager, Rechnung – und die im eigenen Haus weiterentwickelt wird.",
    modules: [
      "Artikelstamm mit Varianten, Preisen und Lieferantenzuordnung",
      "Bestellwesen und Wareneingang",
      "Lagerbestand mit Mindestbestand und Warnungen",
      "Auftragsabwicklung von Angebot bis Lieferschein",
      "Rechnungsstellung mit Übergabe an die Buchhaltung",
    ],
    nonGoals: [
      "Keine Produktionsplanung (PPS) in Stufe 1",
      "Keine eigene Finanzbuchhaltung – Übergabe an den Steuerberater",
    ],
    integrations: [
      "DATEV-/Buchhaltungsexport",
      "Versanddienstleister für Lieferscheine und Sendungsverfolgung",
    ],
    openQuestions: [
      "Welche SAP-Module sind tatsächlich im Einsatz?",
      "Welche gesetzlichen Aufbewahrungs- und Prüfpflichten gelten?",
    ],
  },
  {
    id: "netsuite",
    name: "Oracle NetSuite",
    category: "ERP & Finanzen",
    what: "ERP für Finanzen und Abläufe",
    priceNote: "Grundgebühr plus ca. 99–150 $/Nutzer/Monat, Jahresverträge",
    pain: "Grundgebühr, Nutzergebühr und Modulaufschläge summieren sich; Vertragsverlängerungen kommen regelmäßig mit Preiserhöhungen.",
    goal: "Die genutzten NetSuite-Bereiche als eigene Anwendung – ohne Modulaufschläge und ohne jährliche Nachverhandlung.",
    modules: [
      "Kontenrahmen und Buchungsjournal",
      "Debitoren und Kreditoren mit Zahlungsläufen",
      "Auftrags- und Rechnungsabwicklung",
      "Kostenstellenrechnung und Budgetüberwachung",
      "Monatsabschluss-Auswertungen",
    ],
    nonGoals: [
      "Keine Konzernkonsolidierung über mehrere Gesellschaften in Stufe 1",
      "Keine Mehrwährungsfähigkeit, falls nicht benötigt",
    ],
    integrations: [
      "Bankdatei-Import (CAMT/MT940)",
      "Übergabe an den Steuerberater",
    ],
    openQuestions: [
      "Wie viele Gesellschaften und Währungen sind im Spiel?",
      "Welche Berichte fordert der Wirtschaftsprüfer?",
    ],
  },
  {
    id: "datev",
    name: "DATEV",
    category: "ERP & Finanzen",
    what: "Belegverwaltung & Buchhaltungsvorbereitung",
    priceNote: "Grundgebühren plus Abrechnung je Beleg/Mandant, oft vierstellig jährlich",
    pain: "Die Abrechnung hängt an Belegmengen und Mandantenzahl; die Oberfläche ist auf Kanzleien zugeschnitten, nicht auf den Mandanten.",
    goal: "Belegerfassung und Vorkontierung im eigenen Haus, mit sauberer Übergabe an die Kanzlei – ohne Belegpreise.",
    modules: [
      "Belegerfassung per Upload und E-Mail-Eingang",
      "Automatische Auslesung von Betrag, Datum und Lieferant",
      "Vorkontierung nach hinterlegten Regeln",
      "Freigabe-Workflow vor Übergabe",
      "Export im DATEV-Format an die Kanzlei",
    ],
    nonGoals: [
      "Keine eigene Steuerberechnung oder Jahresabschluss",
      "Kein Ersatz der Kanzleisoftware selbst",
    ],
    integrations: [
      "DATEV-Exportformat (Buchungsstapel)",
      "Rechnungsausgang aus der Warenwirtschaft",
    ],
    openQuestions: [
      "Wie viele Belege pro Monat fallen an?",
      "Welche Formate akzeptiert die Kanzlei?",
    ],
  },

  // -------------------------------------------------------------- HR & Personal
  {
    id: "personio",
    name: "Personio",
    category: "HR & Personal",
    what: "Personalverwaltung",
    priceNote: "ca. 10–20 €/Mitarbeiter/Monat, Mindestlaufzeit meist 12–24 Monate",
    pain: "Abgerechnet wird je Mitarbeiter, auch für die, die das System nie öffnen. Die Vertragslaufzeiten binden über Jahre.",
    goal: "Personalstammdaten, Abwesenheiten und Bewerbungen im eigenen System – Kosten unabhängig von der Mitarbeiterzahl.",
    modules: [
      "Digitale Personalakte mit Dokumenten und Fristen",
      "Abwesenheitsverwaltung mit Genehmigungsworkflow",
      "Arbeitszeiterfassung nach gesetzlicher Vorgabe",
      "Bewerbermanagement von Eingang bis Zusage",
      "Auswertungen: Fluktuation, Urlaubsrückstellungen",
    ],
    nonGoals: [
      "Keine Lohnabrechnung – Übergabe an das Abrechnungsbüro",
      "Kein Schichtplanungsmodul in Stufe 1",
    ],
    integrations: [
      "Export an die Lohnbuchhaltung",
      "Kalender-Abo für genehmigte Abwesenheiten",
    ],
    openQuestions: [
      "Welche Aufbewahrungsfristen gelten für Personaldokumente?",
      "Wer darf welche Teile der Personalakte sehen?",
    ],
  },
  {
    id: "workday",
    name: "Workday",
    category: "HR & Personal",
    what: "HR-Plattform für größere Organisationen",
    priceNote: "Jahresverträge, in mittelgroßen Unternehmen regelmäßig sechsstellig",
    pain: "Einführungsprojekte dauern Monate und binden externe Berater; Anpassungen an eigene Prozesse sind teuer und langsam.",
    goal: "Die tatsächlich benötigten HR-Prozesse abbilden, in einem Bruchteil der Zeit und ohne Beratungsabhängigkeit.",
    modules: [
      "Organisationsstruktur mit Stellen und Berichtslinien",
      "Mitarbeiter-Lebenszyklus: Eintritt, Wechsel, Austritt",
      "Zielvereinbarungen und Feedbackgespräche",
      "Weiterbildungsverwaltung mit Nachweisen",
      "Auswertungen für die Geschäftsführung",
    ],
    nonGoals: [
      "Keine globale Payroll",
      "Kein Nachbau der Workday-Berichtssprache",
    ],
    integrations: [
      "Verzeichnisdienst für Konten (SSO/LDAP)",
      "Export an die Lohnabrechnung",
    ],
    openQuestions: [
      "Wie viele Standorte und Rechtsräume sind betroffen?",
      "Welche Mitbestimmungspflichten bestehen (Betriebsrat)?",
    ],
  },

  // ------------------------------------------------------ Kommunikation & Termine
  {
    id: "slack",
    name: "Slack",
    category: "Kommunikation & Termine",
    what: "Team-Chat",
    priceNote: "ca. 8–15 €/Nutzer/Monat; ohne Bezahlplan Verlauf begrenzt",
    pain: "Im kostenlosen Plan verschwindet der Verlauf, im Bezahlplan zahlt jeder Mitarbeiter monatlich – für Nachrichten, die zum Großteil nach einer Woche irrelevant sind, aber revisionssicher aufbewahrt werden müssen.",
    goal: "Interner Chat mit vollständigem, durchsuchbarem Verlauf im eigenen Betrieb.",
    modules: [
      "Kanäle (öffentlich/privat) und Direktnachrichten",
      "Threads und Reaktionen",
      "Dateianhänge mit Volltextsuche",
      "Benachrichtigungsregeln je Nutzer",
      "Aufbewahrung und Export für Revisionszwecke",
    ],
    nonGoals: [
      "Keine Audio-/Videokonferenz im Chat (siehe eigene Vorlage)",
      "Kein App-Verzeichnis für Erweiterungen",
    ],
    integrations: [
      "Benachrichtigungen aus dem Ticketsystem",
      "Verzeichnisdienst für Konten",
    ],
    openQuestions: [
      "Wie lange müssen Nachrichten aufbewahrt werden?",
      "Sind externe Partner in Kanälen beteiligt?",
    ],
  },
  {
    id: "zoom",
    name: "Zoom",
    category: "Kommunikation & Termine",
    what: "Videokonferenzen",
    priceNote: "ca. 14–19 €/Lizenz/Monat, Zusatzpakete für Webinare",
    pain: "Lizenzen werden pro Gastgeber gekauft, Webinar-Funktionen kosten extra, und Aufzeichnungen liegen bei einem US-Anbieter.",
    goal: "Videokonferenzen auf eigener Infrastruktur, mit Aufzeichnungen im eigenen Speicher.",
    modules: [
      "Konferenzräume mit Einladungslink ohne Konto",
      "Bildschirmfreigabe und Chat während der Konferenz",
      "Aufzeichnung mit Ablage im eigenen Speicher",
      "Warteraum und Moderationsrechte",
      "Terminplanung mit Kalendereinladung",
    ],
    nonGoals: [
      "Keine Telefoneinwahl über das Festnetz in Stufe 1",
      "Keine Webinar-Funktionen mit tausenden Teilnehmern",
    ],
    integrations: [
      "Kalender-Einladungen (ICS)",
      "Verzeichnisdienst für Konten",
    ],
    openQuestions: [
      "Wie viele parallele Konferenzen mit wie vielen Teilnehmern?",
      "Welche Anforderungen gelten für Aufzeichnungen?",
    ],
  },
  {
    id: "calendly",
    name: "Calendly",
    category: "Kommunikation & Termine",
    what: "Terminbuchung für Kunden",
    priceNote: "ca. 10–16 $/Sitz/Monat, Routing-Funktionen in oberen Stufen",
    pain: "Pro Mitarbeiter, der Termine anbietet, fällt eine Gebühr an – bei einem Vertriebsteam summiert sich das, obwohl die Funktion überschaubar ist.",
    goal: "Terminbuchung auf der eigenen Website, mit Verfügbarkeiten aus dem eigenen Kalender.",
    modules: [
      "Buchungsseite je Mitarbeiter oder je Team",
      "Verfügbarkeitsregeln und Pufferzeiten",
      "Automatische Bestätigung und Erinnerung per E-Mail",
      "Verteilung eingehender Anfragen im Team (Round Robin)",
      "Absage und Verschiebung durch den Kunden",
    ],
    nonGoals: [
      "Keine Zahlungsabwicklung bei der Buchung",
      "Keine Ressourcenbuchung (Räume, Geräte) in Stufe 1",
    ],
    integrations: [
      "Kalender-Anbindung für Verfügbarkeiten",
      "Anlage des Kontakts im CRM",
    ],
    openQuestions: [
      "Wie viele Termintypen gibt es?",
      "Sollen Termine automatisch im CRM landen?",
    ],
  },

  // -------------------------------------------------------- Marketing & Analytics
  {
    id: "mailchimp",
    name: "Mailchimp",
    category: "Marketing & Analytics",
    what: "E-Mail-Marketing",
    priceNote: "ab ca. 20 €/Monat, mit wachsender Kontaktzahl schnell dreistellig",
    pain: "Die Kontaktstaffel bestraft Wachstum: Mehr Abonnenten bedeuten automatisch höhere Fixkosten, unabhängig davon, wie oft versendet wird.",
    goal: "Newsletter-Versand mit eigenem Versanddienstleister – Kosten richten sich nach tatsächlich versendeten Mails, nicht nach der Listengröße.",
    modules: [
      "Kontaktlisten mit Segmenten und Tags",
      "Newsletter-Editor mit Vorlagen",
      "Versandplanung und Testversand",
      "Anmelde-/Abmeldeverwaltung mit Double Opt-in",
      "Auswertung: Zustellung, Öffnungen, Klicks, Abmeldungen",
    ],
    nonGoals: [
      "Keine mehrstufigen Marketing-Automationsstrecken in Stufe 1",
      "Kein Social-Media-Modul",
    ],
    integrations: [
      "Versanddienstleister (SMTP/API) für die Zustellung",
      "Kontaktabgleich mit dem CRM",
    ],
    openQuestions: [
      "Wie groß ist der Verteiler, wie oft wird versendet?",
      "Wie ist die Einwilligung heute dokumentiert (DSGVO)?",
    ],
  },
  {
    id: "klaviyo",
    name: "Klaviyo",
    category: "Marketing & Analytics",
    what: "Shop-Marketing & Automationsstrecken",
    priceNote: "ab ca. 45 $/Monat, bei größeren Verteilern schnell vierstellig",
    pain: "Preis steigt mit Profilanzahl und SMS-Volumen – gerade im Wachstum wird die Rechnung unvorhersehbar.",
    goal: "Automatisierte Kundenkommunikation entlang des Kaufverhaltens, mit planbaren Kosten.",
    modules: [
      "Kundenprofile mit Kauf- und Verhaltenshistorie",
      "Automationsstrecken (Warenkorbabbruch, Nachkauf, Reaktivierung)",
      "Segmentierung nach Umsatz und Verhalten",
      "A/B-Tests für Betreff und Inhalt",
      "Umsatzzuordnung je Strecke",
    ],
    nonGoals: [
      "Kein SMS-Versand in Stufe 1",
      "Keine Vorhersagemodelle für Kundenwert",
    ],
    integrations: [
      "Shop-Anbindung für Bestell- und Warenkorbdaten",
      "Versanddienstleister für die Zustellung",
    ],
    openQuestions: [
      "Welche Strecken erwirtschaften heute den Umsatz?",
      "Wie viele Profile sind aktiv?",
    ],
  },
  {
    id: "tableau",
    name: "Tableau",
    category: "Marketing & Analytics",
    what: "Auswertungen & Dashboards",
    priceNote: "ca. 15 $/Viewer bis 75 $/Creator pro Monat, Jahresvorauszahlung",
    pain: "Selbst reine Betrachter kosten monatlich – Kennzahlen im Unternehmen zu verbreiten wird dadurch zur Budgetfrage.",
    goal: "Dashboards, die jeder Mitarbeiter ansehen darf, direkt auf den eigenen Datenbeständen.",
    modules: [
      "Datenanbindung an die operativen Systeme",
      "Kennzahlen-Dashboards je Fachbereich",
      "Filter und Zeiträume für den Betrachter",
      "Geplanter Berichtsversand per E-Mail",
      "Rechte je Dashboard und je Kennzahl",
    ],
    nonGoals: [
      "Kein Self-Service-Modellierer für Endnutzer",
      "Kein Data Warehouse-Aufbau in Stufe 1",
    ],
    integrations: [
      "Lesezugriff auf die Datenbanken der Fachsysteme",
      "Export nach Excel/PDF",
    ],
    openQuestions: [
      "Welche Kennzahlen werden wirklich zur Steuerung genutzt?",
      "Wie aktuell müssen die Zahlen sein (täglich, live)?",
    ],
  },
  {
    id: "typeform",
    name: "Typeform",
    category: "Marketing & Analytics",
    what: "Formulare & Umfragen",
    priceNote: "ca. 25–83 €/Monat, Antworten pro Monat kontingentiert",
    pain: "Antwortkontingente pro Monat: Läuft eine Umfrage gut, ist sie mitten im Lauf gedeckelt oder erzwingt die nächste Stufe.",
    goal: "Formulare und Umfragen ohne Antwortlimit, mit Daten in der eigenen Datenbank.",
    modules: [
      "Formular-Editor mit Feldtypen und Verzweigungslogik",
      "Mehrseitige Formulare mit Fortschrittsanzeige",
      "Antwortauswertung mit Diagrammen und Export",
      "Einbettung in Website oder Versand per Link",
      "Benachrichtigung bei neuen Antworten",
    ],
    nonGoals: [
      "Keine Zahlungsabwicklung im Formular",
      "Keine Umfrage-Panels/Teilnehmerbeschaffung",
    ],
    integrations: [
      "Antworten als Datensätze in Fachsysteme (z.B. Anforderungen, Leads)",
      "E-Mail-Benachrichtigung an Zuständige",
    ],
    openQuestions: [
      "Wie viele Antworten pro Monat sind zu erwarten?",
      "Werden personenbezogene Daten erhoben (DSGVO-Prüfung)?",
    ],
  },

  // ------------------------------------------------------------ Shop & Verträge
  {
    id: "shopify",
    name: "Shopify",
    category: "Shop & Verträge",
    what: "Online-Shop",
    priceNote: "ca. 36–384 €/Monat plus Transaktionsgebühren und kostenpflichtige Apps",
    pain: "Zur Grundgebühr kommen Transaktionsgebühren bei fremden Zahlungsanbietern und Monatsgebühren für Apps, die Standardfunktionen nachrüsten. Der Warenkorb gehört am Ende der Plattform.",
    goal: "Ein Shop auf eigener Infrastruktur, ohne Transaktionsbeteiligung und ohne App-Abos für Grundfunktionen.",
    modules: [
      "Produktkatalog mit Varianten, Bildern und Beständen",
      "Warenkorb und Kasse mit Gastbestellung",
      "Zahlungsanbindung (Karte, Rechnung, Lastschrift)",
      "Bestellverwaltung mit Status und Versandetiketten",
      "Rabatte, Gutscheine und Staffelpreise",
    ],
    nonGoals: [
      "Kein Marktplatz mit mehreren Händlern",
      "Kein eigenes Theme-System für Dritte",
    ],
    integrations: [
      "Zahlungsdienstleister",
      "Warenwirtschaft für Bestände und Rechnungen",
    ],
    openQuestions: [
      "Wie viele Artikel und Bestellungen pro Monat?",
      "Welche Zahlarten sind zwingend?",
    ],
  },
  {
    id: "docusign",
    name: "DocuSign",
    category: "Shop & Verträge",
    what: "Digitale Signatur & Vertragsversand",
    priceNote: "ca. 10–40 €/Nutzer/Monat mit begrenztem Umschlag-Kontingent",
    pain: "Umschlag-Kontingente pro Jahr: Wer viele Verträge versendet, zahlt nach – und jeder zusätzliche interne Versender kostet eine Lizenz.",
    goal: "Vertragsversand und Unterschrift im eigenen System, ohne Kontingente, mit Beweiswert nach eIDAS.",
    modules: [
      "Vertragsvorlagen mit Platzhaltern",
      "Signaturlauf mit mehreren Unterzeichnern in Reihenfolge",
      "Erinnerungen bei ausstehender Unterschrift",
      "Prüfprotokoll (Audit-Trail) je Dokument",
      "Revisionssichere Ablage unterschriebener Verträge",
    ],
    nonGoals: [
      "Keine qualifizierte elektronische Signatur ohne zertifizierten Vertrauensdienst",
      "Kein Vertragsmanagement mit Fristenüberwachung in Stufe 1",
    ],
    integrations: [
      "Vertrauensdiensteanbieter für die Signatur",
      "Ablage im Dokumentenspeicher",
    ],
    openQuestions: [
      "Welche Signaturstufe ist rechtlich nötig (einfach/fortgeschritten/qualifiziert)?",
      "Wie viele Verträge pro Monat?",
    ],
  },

  // ------------------------------------------------------------- Automatisierung
  {
    id: "zapier",
    name: "Zapier",
    category: "Automatisierung",
    what: "Automatisierung zwischen Systemen",
    priceNote: "ca. 20–100+ €/Monat, Abrechnung je ausgeführter Aufgabe",
    pain: "Abgerechnet wird pro ausgeführter Aufgabe – erfolgreiche Automatisierung erhöht die Rechnung. Bei Fehlern laufen Aufgaben doppelt und kosten trotzdem.",
    goal: "Die etablierten Automatisierungen fest implementieren: verlässlich, nachvollziehbar und ohne Abrechnung je Ausführung.",
    modules: [
      "Auslöser aus den angebundenen Systemen (Webhook, Zeitplan, Datenänderung)",
      "Verarbeitungsschritte mit Bedingungen",
      "Fehlerbehandlung mit Wiederholung und Benachrichtigung",
      "Protokoll jeder Ausführung mit Ein- und Ausgabe",
      "Übersicht laufender und fehlgeschlagener Abläufe",
    ],
    nonGoals: [
      "Kein grafischer Baukasten für Endnutzer in Stufe 1",
      "Keine Konnektoren zu Systemen, die nicht im Einsatz sind",
    ],
    integrations: [
      "Die real angebundenen Systeme (aus der Connector-Konfiguration des Projekts)",
      "Benachrichtigung des zuständigen Teams bei Fehlern",
    ],
    openQuestions: [
      "Welche Zaps laufen heute und wie oft?",
      "Welche davon sind geschäftskritisch (Ausfall = Umsatzverlust)?",
    ],
  },
];

export function findConceptTemplate(id: string): ConceptTemplate | undefined {
  return CONCEPT_TEMPLATES.find((template) => template.id === id);
}

/// Baut aus einer Vorlage den Konzept-Freitext. Bewusst Markdown-ähnlich als
/// Klartext, weil `Concept.content` ein einfaches Textfeld ist und der Entwurf
/// vom Berater direkt weiterbearbeitet wird.
export function renderConceptTemplate(template: ConceptTemplate): string {
  const bullets = (items: string[]) => items.map((item) => `- ${item}`);

  return [
    `# ${template.what} statt ${template.name}`,
    "",
    "## Ausgangslage",
    `Heute im Einsatz: ${template.name} (${template.category}).`,
    `Preisrahmen des Originals: ${template.priceNote}.`,
    template.pain,
    "",
    "## Ziel",
    template.goal,
    "",
    "## Kernmodule",
    ...bullets(template.modules),
    "",
    "## Bewusst nicht im Umfang",
    ...bullets(template.nonGoals),
    "",
    "## Schnittstellen",
    ...bullets(template.integrations),
    "",
    "## Vor der Freigabe zu klären",
    ...bullets(template.openQuestions),
    `- Datenübernahme aus ${template.name}: Umfang, Format, Stichtag`,
    "- Nutzerzahl, Rollen und Rechte zum Start",
    "- Betrieb: eigene Infrastruktur oder gehostet, Backup- und Ausfallkonzept",
    "- Ablösetermin und Parallelbetrieb während der Umstellung",
    "",
    "---",
    `Aus Vorlage „${template.name}" erzeugt – Ausgangspunkt, kein fertiges Konzept.`,
    "Die Preisangabe ist eine grobe Größenordnung und vor der Angebotsabgabe zu prüfen.",
  ].join("\n");
}
