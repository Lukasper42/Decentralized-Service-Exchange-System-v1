# Rauchtests

Browser- und Prozess-Tests gegen den echten Relay (Speicher-Modus), die echte Mailbox und die gebaute Web-UI. Sie ergänzen die
Unit-Tests und fangen Fehler an den Nahtstellen (CORS, Aufbau der Ansichten, Aktivierung von Endpoints).

Voraussetzungen (im Repo-Wurzelordner):

    npm run build                                  # baut Ledger, Web und Mailbox (Pakete vorher einzeln installieren)
    npm i --no-save playwright && npx playwright install chromium

Freie Ports: 8080 (Web-UI), 3000 (Relay), 8787 (Mailbox), 9911 (Test-Senke). Starten:

    npm run smoke            # alle vier nacheinander
    node tools/smoke/ui.mjs  # einzeln

| Skript | Prüft |
| --- | --- |
| ui.mjs | Schlüssel erzeugen, Genesis, Sync und Kettenprüfung, Explorer, Entsperren, Deals, consentDeal, Rollback-Erkennung, Fehlerfälle |
| messages.mjs | Ende-zu-Ende-Nachrichten über zwei Browser-Profile und die Mailbox |
| jury.mjs | Streitfall mit 3 Juroren, castVote in der UI, Auflösung (Test-Genesis mit Jury-Schwellen 0, nur für den Test) |
| reports.mjs | POST /v1/reports gegen den echten Relay: 404 ohne Konfiguration, 201/200, Parallelität, Neustart, beschädigte Outbox, Wiederzustellung |

Ausgabe: je Prüfpunkt `OK` oder `FAIL`; Exitcode 1, sobald ein Punkt fehlschlägt. Arbeitsdateien liegen in einem Temp-Ordner.
Grenzen: nur Chromium, Speicher-Modus des Relays, Jury nicht mit der echten Beta-Policy.
