# Prompt 3 für DeepSeek: ESLint-Konfiguration (offen, Ausgabe steht aus)

ROLLE
Du bist Senior-TypeScript-Entwickler. Erzeuge genau diese neue Datei und gib NUR die Datei aus; die erste Zeile ist `// eslint.config.js`. LF, 2 Leerzeichen.
1. eslint.config.js

KONTEXT
Das Repo ist ein ESM-Projekt (`"type": "module"`), TypeScript strict, Node 22, Tests mit `node:test`, Quellen in `packages/**/src`, `apps/**`, kompilierte Ausgabe in `dist/`. Installiert werden lokal `eslint` (Version 9) und `typescript-eslint` (Version 8) als devDependencies; ESLint-Flat-Config. Es gibt `tsconfig.json` im Repo-Root (include: `apps/**/*.ts`, `packages/**/*.ts`).

AUFGABE
- Ignoriere `dist/`, `node_modules/`, `output/`, `docs/`.
- Basis: `@eslint/js` recommended und `typescript-eslint` `strictTypeChecked` mit `parserOptions.projectService: true` und `tsconfigRootDir: import.meta.dirname`.
- Zusatzregeln als Fehler: `eqeqeq` (always), `no-var`, `prefer-const`, `@typescript-eslint/no-explicit-any`, `@typescript-eslint/ban-ts-comment` (kein `@ts-ignore`), `@typescript-eslint/no-floating-promises`, `@typescript-eslint/switch-exhaustiveness-check`, `@typescript-eslint/consistent-type-imports` (`prefer: 'type-imports'`, `fixStyle: 'inline-type-imports'`), `@typescript-eslint/no-unused-vars` (Argumente und Variablen mit führendem `_` erlaubt), `no-restricted-properties` für `Math.random` und `Date.now`.
- Ausnahmen: In `**/*.test.ts` und `packages/testing/**` sind `Date.now` und `no-non-null-assertion` erlaubt, die Regel `@typescript-eslint/no-unnecessary-condition` ist aus. In `apps/**` ist `Date.now` erlaubt (Composition Root).
- Regeln, die in diesem Repo bewusst NICHT gelten sollen: `@typescript-eslint/restrict-template-expressions` (Zahlen in Templates sind erlaubt: `allowNumber: true`), `@typescript-eslint/no-confusing-void-expression` aus, `@typescript-eslint/unified-signatures` aus.
- Die Datei exportiert ein Array über `tseslint.config(...)`.

SELBSTPRÜFUNG
Gültige Flat-Config in ESM; keine Imports außer `@eslint/js` und `typescript-eslint`; keine Regel, die eine Datei außerhalb der `tsconfig.json`-Abdeckung verlangt (Konfigdateien im Root brauchen eine eigene Ausnahme mit `tseslint.configs.disableTypeChecked`).
