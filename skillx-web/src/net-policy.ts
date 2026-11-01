export type RelayUrlCheck =
  | { readonly ok: true; readonly url: string; readonly onion: boolean }
  | { readonly ok: false; readonly reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function checkRelayUrl(input: string): RelayUrlCheck {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'Invalid relay URL.' };
  }
  if (u.username !== '' || u.password !== '') {
    return { ok: false, reason: 'Credentials in the URL are not allowed.' };
  }
  if (u.search !== '' || u.hash !== '') {
    return { ok: false, reason: 'Query and fragment in the relay URL are not allowed.' };
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
    reason: 'Only https:// allowed (http:// only for .onion and localhost).',
  };
}
