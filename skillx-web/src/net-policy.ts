export type RelayUrlCheck =
  | { readonly ok: true; readonly url: string; readonly onion: boolean }
  | { readonly ok: false; readonly reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function checkRelayUrl(input: string): RelayUrlCheck {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'Ungültige Relay-URL.' };
  }
  if (u.username !== '' || u.password !== '') {
    return { ok: false, reason: 'Zugangsdaten in der URL sind nicht erlaubt.' };
  }
  if (u.search !== '' || u.hash !== '') {
    return { ok: false, reason: 'Query und Fragment in der Relay-URL sind nicht erlaubt.' };
  }
  const host = u.hostname.toLowerCase();
  const onion = host.endsWith('.onion');
  if (u.protocol === 'https:') {
    return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, ''), onion };
  }
  if (u.protocol === 'http:' && (onion || LOCAL_HOSTS.has(host))) {
    return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, ''), onion };
  }
  return {
    ok: false,
    reason: 'Nur https:// erlaubt (http:// nur für .onion und localhost).',
  };
}
