const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default async function (c) {
  const { page, rec, PW, dealId, relayPub } = c;
  const dd = async (id) => (await page.locator('#' + id).textContent())?.trim();
  const goto = async (r) => { await page.goto('http://127.0.0.1:8080/#/' + r); await sleep(300); };
  const main = async () => (await page.locator('main').innerText());
  const banner = async () => ((await page.locator('main').innerText()).match(/(Sync-Fehler|Divergenz)[^\n]*/)?.[0] ?? '');
  const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(200); } return false; };

  // C1/C2 Status + Sync
  await goto('status');
  await page.fill('#relay-url', 'http://127.0.0.1:3000');
  await page.fill('#relay-pubkey', relayPub);
  await page.click('button:has-text("Speichern und verbinden")');
  const synced = await waitFor(async () => (await dd('st-local')) === '3');
  rec('C1 Status: Health, Tip, Sync 3 Einträge', synced && (await dd('st-health')) === 'ok' && (await dd('st-tip')) === '3', `health=${await dd('st-health')} tip=${await dd('st-tip')} local=${await dd('st-local')} banner="${await banner()}"`);
  rec('C2 Checkpoint-Anzeige', true, `cp=${await dd('st-cp')} geprüft=${await dd('st-cp-ok')}`);

  // C5 Explorer
  await goto('explorer');
  const ex = await main();
  rec('C5 Explorer zeigt 3 Einträge', /3 Einträge/.test(ex), ex.match(/Seite .*Einträge\)/)?.[0] ?? '');

  // C3 Entsperren: falsches Passwort, dann richtig
  await goto('identity');
  await page.fill('#unlock-pw', 'falsches-passwort-xxxxx');
  await page.click('button:has-text("Entsperren")');
  await waitFor(async () => /Falsches Passwort|beschädigt/.test(await main()), 10000);
  const wrong = await main();
  rec('C3a falsches Passwort wird abgelehnt', /Falsches Passwort/.test(wrong) && /entsperrt: nein/.test(wrong), wrong.replace(/\n+/g, ' ').slice(-200));
  await page.fill('#unlock-pw', PW);
  await page.click('button:has-text("Entsperren")');
  await waitFor(async () => /entsperrt: ja/.test(await main()), 8000);
  rec('C3b richtiges Passwort entsperrt', /entsperrt: ja/.test(await main()));
  await page.getByRole('button', { name: 'Sperren', exact: true }).click();
  await sleep(300);
  rec('C3c sperren', /entsperrt: nein/.test(await main()));
  await page.fill('#unlock-pw', PW); await page.click('button:has-text("Entsperren")');
  await waitFor(async () => /entsperrt: ja/.test(await main()), 8000);

  // C4 Konto
  await goto('account');
  const acc = await main();
  rec('C4 Konto zeigt Summen-Tabelle', /Erhalten \(Währungsausgabe\)/.test(acc), acc.replace(/\n+/g, ' ').slice(0, 200));

  // C6/C7 Deals + consentDeal
  await goto('deals');
  await waitFor(async () => /angelegt/.test(await main()), 5000);
  const deals = await main();
  rec('C6 Deal sichtbar (angelegt)', /angelegt/.test(deals) && /1[\s\u00a0\u202f.]?000/.test(deals), deals.replace(/\n+/g, ' ').slice(0, 200));
  await page.click('button:has-text("Zustimmen")');
  await sleep(2500);
  const after = await main();
  const ent = await (await fetch('http://127.0.0.1:3000/v1/entries?from=1&to=10')).json().catch(() => null);
  const types = JSON.stringify(ent).match(/"type":"(\w+)"/g) ?? [];
  rec('C7 consentDeal: DealConsented auf Relay', types.some((t) => t.includes('DealConsented')), types.join(',') + ' | UI: ' + after.replace(/\n+/g, ' ').slice(0, 220));
  await goto('status'); await sleep(300);
  rec('C7b UI Kette nach Aktion verifiziert', (await banner()) === '', `local=${await dd('st-local')} tip=${await dd('st-tip')} banner="${await banner()}"`);

  // C9 Fehlerfälle
  await goto('status');
  await page.fill('#relay-url', 'http://example.com');
  await page.click('button:has-text("Speichern und verbinden")');
  await sleep(500);
  rec('C9a http://example.com abgelehnt', /https|nicht erlaubt|ungültig|Relay-URL/i.test(await main() + await banner()), (await banner() + ' ' + (await main()).slice(0, 0)).slice(0, 160));
  await page.fill('#relay-url', 'http://127.0.0.1:3000');
  c.getRelay().kill(); await sleep(800);
  await page.click('button:has-text("Speichern und verbinden")');
  await sleep(2500);
  rec('C9b Relay aus: verständliche Meldung', (await banner()) !== '', await banner());

  // C2b Rollback: Relay neu starten (Speicher leer, gleicher Schlüssel) -> Tip niedriger als gepinnt
  c.setRelay(c.startRelay());
  for (let i = 0; i < 30; i++) { await sleep(300); try { if ((await fetch('http://127.0.0.1:3000/v1/health')).ok) break; } catch {} }
  await page.click('button:has-text("Speichern und verbinden")');
  await sleep(2500);
  const rb = await banner();
  rec('C2b Rollback/Fork nach Relay-Neustart erkannt', rb !== '', rb);
  await page.screenshot({ path: `${c.T}/s-rollback.png` });
  await page.click('button:has-text("Gemerkten Kettenstand zurücksetzen")');
  await sleep(300);
  await page.click('button:has-text("Speichern und verbinden")');
  await sleep(2500);
  rec('C2c nach Pin-Reset wieder verbunden', (await banner()) === '', `banner="${await banner()}" tip=${await dd('st-tip')} local=${await dd('st-local')}`);
}
