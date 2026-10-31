# skillx-web

Eigenständige Web-UI für das SkillX-Ledger (TypeScript, keine Runtime-Dependencies).

## Build
npm install
npm run build   # tsc -> dist/

## Lokal ausführen
npm run build
npm start   # node serve.mjs, nur 127.0.0.1:8080 (anderer Port: node serve.mjs 9000)
Dann http://127.0.0.1:8080 öffnen. Der Server hat keine Abhängigkeiten, liefert nur index.html, styles.css und dist/*.js und setzt Sicherheits-Header. Kein Doppelklick auf index.html (file:// geht mit ES-Modulen/CSP nicht).

## Tests
npm test   # node:test gegen dist/**/*.test.js

## Hinweis Relay-CORS
Der Relay muss für die Origin dieser UI CORS freigeben (GET + POST, application/json).

## Anonymität und Sicherheit
- Die UI kann deine IP-Adresse nicht verbergen: Der Relay sieht IP und Zugriffszeiten. Nutze den Tor Browser (idealerweise mit .onion-Relay) oder ein vertrauenswürdiges VPN.
- Dein Pseudonym (Public Key) ist auf der Kette öffentlich; alle Aktionen sind damit verknüpfbar.
- Schlüssel: nur passwortverschlüsselt (PBKDF2-SHA-256 600000 + AES-GCM), Passwort mindestens 16 Zeichen, Sperre nach 10 Minuten.
- Netzwerk: nur https:// (http:// nur für .onion und localhost), keine Cookies, kein Referrer, kein Cache, keine Weiterleitungen.
- CSP: keine Skripte/Styles/Bilder von Dritten, `connect-src` nur https, .onion und localhost. Für strengere Begrenzung `connect-src` auf die eigene Relay-Origin setzen, zusätzlich HTTP-Header (`frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`) am Webserver setzen.
- Ausliefern nur über HTTPS oder lokal; ein kompromittierter Webserver könnte manipulierten Code ausliefern.

## Nachrichten (Ende-zu-Ende, über skillx-mailbox)
- Ansicht "Nachrichten": Postfach-URL setzen, Schlüsselbündel veröffentlichen, senden, Posteingang abrufen.
- Der X25519-Nachrichtenschlüssel wird deterministisch aus der Identität abgeleitet (nichts extra zu speichern, auf jedem Gerät mit derselben Identität wiederherstellbar).
- Das Bündel des Empfängers wird gegen dessen Identity-Pubkey geprüft (Server kann keinen fremden Schlüssel unterschieben).
- Verlauf liegt nur im Speicher und wird beim Sperren gelöscht; optional verschlüsselt (PBKDF2 + AES-GCM) lokal speicherbar.
- Der Postfach-Server sieht IP und Zugriffszeiten: Tor/VPN nutzen.
