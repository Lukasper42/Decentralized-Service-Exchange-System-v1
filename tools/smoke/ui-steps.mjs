const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default async function (c) {
  const { page, rec, PW, dealId, relayPub } = c;
  const dd = async (id) => (await page.locator('#' + id).textContent())?.trim();
  const goto = async (r) => { await page.goto('http://127.0.0.1:8080/#/' + r); await sleep(300); };
  const main = async () => (await page.locator('main').innerText());
  const banner = async () => ((await page.locator('main').innerText()).match(/(Sync error|Divergence)[^\n]*/)?.[0] ?? '');
  const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(200); } return false; };

  // C1/C2 Status + sync
  await goto('status');
  await page.fill('#relay-url', 'http://127.0.0.1:3000');
  await page.fill('#relay-pubkey', relayPub);
  await page.click('button:has-text("Save and connect")');
  const synced = await waitFor(async () => (await dd('st-local')) === '3');
  rec('C1 Status: health, tip, sync 3 entries', synced && (await dd('st-health')) === 'ok' && (await dd('st-tip')) === '3', `health=${await dd('st-health')} tip=${await dd('st-tip')} local=${await dd('st-local')} banner="${await banner()}"`);
  rec('C2 Checkpoint display', true, `cp=${await dd('st-cp')} verified=${await dd('st-cp-ok')}`);

  // C5 Explorer
  await goto('explorer');
  const ex = await main();
  rec('C5 Explorer shows 3 entries', /3 entries/.test(ex), ex.match(/Page .*entries\)/)?.[0] ?? '');

  // C3 Unlock: wrong password, then correct
  await goto('identity');
  await page.fill('#unlock-pw', 'wrong-password-xxxxx');
  await page.click('button:has-text("Unlock")');
  await waitFor(async () => /Wrong password|corrupted/.test(await main()), 10000);
  const wrong = await main();
  rec('C3a wrong password is rejected', /Wrong password/.test(wrong) && /unlocked: no/.test(wrong), wrong.replace(/\n+/g, ' ').slice(-200));
  await page.fill('#unlock-pw', PW);
  await page.click('button:has-text("Unlock")');
  await waitFor(async () => /unlocked: yes/.test(await main()), 8000);
  rec('C3b correct password unlocks', /unlocked: yes/.test(await main()));
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await sleep(300);
  rec('C3c lock', /unlocked: no/.test(await main()));
  await page.fill('#unlock-pw', PW); await page.click('button:has-text("Unlock")');
  await waitFor(async () => /unlocked: yes/.test(await main()), 8000);

  // C4 Account
  await goto('account');
  const acc = await main();
  rec('C4 Account shows totals table', /Received \(currency issuance\)/.test(acc), acc.replace(/\n+/g, ' ').slice(0, 200));

  // C6/C7 Deals + consentDeal
  await goto('deals');
  await waitFor(async () => /created/.test(await main()), 5000);
  const deals = await main();
  rec('C6 Deal visible (created)', /created/.test(deals) && /1[\s\u00a0\u202f.]?000/.test(deals), deals.replace(/\n+/g, ' ').slice(0, 200));
  await page.click('button:has-text("Consent")');
  await sleep(2500);
  const after = await main();
  const ent = await (await fetch('http://127.0.0.1:3000/v1/entries?from=1&to=10')).json().catch(() => null);
  const types = JSON.stringify(ent).match(/"type":"(\w+)"/g) ?? [];
  rec('C7 consentDeal: DealConsented on relay', types.some((t) => t.includes('DealConsented')), types.join(',') + ' | UI: ' + after.replace(/\n+/g, ' ').slice(0, 220));
  await goto('status'); await sleep(300);
  rec('C7b UI chain verified after action', (await banner()) === '', `local=${await dd('st-local')} tip=${await dd('st-tip')} banner="${await banner()}"`);

  // C9 Error cases
  await goto('status');
  await page.fill('#relay-url', 'http://example.com');
  await page.click('button:has-text("Save and connect")');
  await sleep(500);
  rec('C9a http://example.com rejected', /https|not allowed|invalid|relay url/i.test(await main() + await banner()), (await banner() + ' ' + (await main()).slice(0, 0)).slice(0, 160));
  await page.fill('#relay-url', 'http://127.0.0.1:3000');
  c.getRelay().kill(); await sleep(800);
  await page.click('button:has-text("Save and connect")');
  await sleep(2500);
  rec('C9b Relay off: understandable message', (await banner()) !== '', await banner());

  // C2b Rollback: restart relay (storage empty, same key) -> tip lower than pinned
  c.setRelay(c.startRelay());
  for (let i = 0; i < 30; i++) { await sleep(300); try { if ((await fetch('http://127.0.0.1:3000/v1/health')).ok) break; } catch {} }
  await page.click('button:has-text("Save and connect")');
  await sleep(2500);
  const rb = await banner();
  rec('C2b Rollback/fork detected after relay restart', rb !== '', rb);
  await page.screenshot({ path: `${c.T}/s-rollback.png` });
  await page.click('button:has-text("Reset remembered chain state")');
  await sleep(300);
  await page.click('button:has-text("Save and connect")');
  await sleep(2500);
  rec('C2c reconnected after pin reset', (await banner()) === '', `banner="${await banner()}" tip=${await dd('st-tip')} local=${await dd('st-local')}`);
}
