-- SkillX public-test runtime storage.
-- Review and apply manually only after approval. This file has NOT been executed.
-- All runtime data is isolated from the existing Notion/documentation schemas.

begin;

create schema if not exists skillx_runtime;

revoke all on schema skillx_runtime from public, anon, authenticated;
grant usage on schema skillx_runtime to service_role;

create table if not exists skillx_runtime.write_guard (
  id integer primary key check (id = 1)
);
insert into skillx_runtime.write_guard(id) values (1) on conflict (id) do nothing;

create table if not exists skillx_runtime.rate_buckets (
  bucket_key text not null,
  window_start_ms bigint not null check (window_start_ms >= 0),
  request_count integer not null check (request_count > 0),
  primary key (bucket_key, window_start_ms)
);

create table if not exists skillx_runtime.ledger_entries (
  sequence bigint primary key check (sequence > 0),
  event_hash text not null unique check (event_hash ~ '^[0-9a-f]{64}$'),
  signer text not null,
  prev_hash text null check (prev_hash is null or prev_hash ~ '^[0-9a-f]{64}$'),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  entry_json text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists skillx_runtime_ledger_signer_prev
  on skillx_runtime.ledger_entries(signer, prev_hash) where prev_hash is not null;
create unique index if not exists skillx_runtime_ledger_signer_genesis
  on skillx_runtime.ledger_entries(signer) where prev_hash is null;

create or replace function skillx_runtime.reject_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'ledger_entries is append-only' using errcode = '55000';
end;
$$;

drop trigger if exists ledger_immutable_trigger on skillx_runtime.ledger_entries;
create trigger ledger_immutable_trigger
before update or delete on skillx_runtime.ledger_entries
for each row execute function skillx_runtime.reject_ledger_mutation();

create table if not exists skillx_runtime.mailbox_keys (
  mailbox_id text primary key check (mailbox_id ~ '^[0-9a-f]{64}$'),
  identity_pubkey text not null unique,
  x_pubkey text not null,
  created_at text not null,
  sig text not null
);
create table if not exists skillx_runtime.mailbox_counters (
  mailbox_id text primary key references skillx_runtime.mailbox_keys(mailbox_id) on delete cascade,
  last_seq bigint not null default 0 check (last_seq >= 0)
);
create table if not exists skillx_runtime.mailbox_messages (
  mailbox_id text not null references skillx_runtime.mailbox_keys(mailbox_id) on delete cascade,
  seq bigint not null check (seq > 0),
  id text not null check (id ~ '^[0-9a-f]{32}$'),
  envelope jsonb not null,
  stored_at bigint not null check (stored_at >= 0),
  primary key (mailbox_id, seq),
  unique (mailbox_id, id)
);
create index if not exists skillx_runtime_mailbox_messages_ttl
  on skillx_runtime.mailbox_messages(mailbox_id, stored_at);
create table if not exists skillx_runtime.mailbox_post_log (
  mailbox_id text not null references skillx_runtime.mailbox_keys(mailbox_id) on delete cascade,
  posted_at bigint not null check (posted_at >= 0)
);
create index if not exists skillx_runtime_mailbox_post_log_recent
  on skillx_runtime.mailbox_post_log(mailbox_id, posted_at);

alter table skillx_runtime.write_guard enable row level security;
alter table skillx_runtime.rate_buckets enable row level security;
alter table skillx_runtime.ledger_entries enable row level security;
alter table skillx_runtime.mailbox_keys enable row level security;
alter table skillx_runtime.mailbox_counters enable row level security;
alter table skillx_runtime.mailbox_messages enable row level security;
alter table skillx_runtime.mailbox_post_log enable row level security;

revoke all on all tables in schema skillx_runtime from public, anon, authenticated;
grant select, insert on skillx_runtime.ledger_entries to service_role;
grant select, insert, update on skillx_runtime.mailbox_keys to service_role;
grant select, insert, update on skillx_runtime.mailbox_counters to service_role;
grant select, insert, delete on skillx_runtime.mailbox_messages to service_role;
grant select, insert, delete on skillx_runtime.mailbox_post_log to service_role;
grant select, update on skillx_runtime.write_guard to service_role;
grant select, insert, update, delete on skillx_runtime.rate_buckets to service_role;
revoke truncate, references, trigger on skillx_runtime.ledger_entries from service_role;

create or replace function public.skillx_runtime_ledger_load()
returns table(sequence bigint, checksum text, entry_json text)
language sql
security invoker
set search_path = ''
as $$
  select e.sequence, e.checksum, e.entry_json
  from skillx_runtime.ledger_entries as e
  order by e.sequence;
$$;

create or replace function public.skillx_runtime_ledger_append(
  p_sequence bigint,
  p_event_hash text,
  p_signer text,
  p_prev_hash text,
  p_checksum text,
  p_entry_json text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_next_sequence bigint;
  v_signer_tip text;
begin
  if p_sequence is null or p_sequence < 1
     or p_event_hash !~ '^[0-9a-f]{64}$'
     or p_checksum !~ '^[0-9a-f]{64}$'
     or p_signer is null or length(p_signer) = 0
     or (p_prev_hash is not null and p_prev_hash !~ '^[0-9a-f]{64}$')
     or p_entry_json is null then
    raise exception 'invalid ledger append arguments' using errcode = '22023';
  end if;

  perform 1 from skillx_runtime.write_guard where id = 1 for update;
  if not found then
    raise exception 'ledger write guard is missing' using errcode = '55000';
  end if;

  select coalesce(max(sequence), 0) + 1
    into v_next_sequence
    from skillx_runtime.ledger_entries;
  if p_sequence <> v_next_sequence then
    raise exception 'stale ledger sequence; reload and retry' using errcode = '40001';
  end if;

  select event_hash into v_signer_tip
    from skillx_runtime.ledger_entries
    where signer = p_signer
    order by sequence desc
    limit 1;
  if p_prev_hash is distinct from v_signer_tip then
    raise exception 'stale signer tip; reload and retry' using errcode = '40001';
  end if;

  insert into skillx_runtime.ledger_entries(
    sequence, event_hash, signer, prev_hash, checksum, entry_json
  ) values (
    p_sequence, p_event_hash, p_signer, p_prev_hash, p_checksum, p_entry_json
  );
end;
$$;

create or replace function public.skillx_runtime_rate_limit(
  p_bucket_keys text[],
  p_limits integer[],
  p_now_ms bigint,
  p_window_ms bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $
declare
  v_window_start bigint;
  v_count integer;
  i integer;
begin
  if p_bucket_keys is null or p_limits is null
     or cardinality(p_bucket_keys) < 1
     or cardinality(p_bucket_keys) <> cardinality(p_limits)
     or p_now_ms is null or p_now_ms < 0
     or p_window_ms is null or p_window_ms < 1000 then
    raise exception 'invalid rate limit arguments' using errcode = '22023';
  end if;

  v_window_start := p_now_ms - (p_now_ms % p_window_ms);
  for i in 1..cardinality(p_bucket_keys) loop
    if p_bucket_keys[i] is null or length(p_bucket_keys[i]) < 16
       or p_limits[i] is null or p_limits[i] < 1 or p_limits[i] > 10000 then
      raise exception 'invalid rate limit bucket' using errcode = '22023';
    end if;

    insert into skillx_runtime.rate_buckets(bucket_key, window_start_ms, request_count)
      values (p_bucket_keys[i], v_window_start, 1)
    on conflict (bucket_key, window_start_ms)
      do update set request_count = least(
        skillx_runtime.rate_buckets.request_count + 1,
        p_limits[i] + 1
      )
    returning request_count into v_count;

    if v_count > p_limits[i] then
      -- Bound denied requests to limit + 1, preventing unbounded counter growth.
      delete from skillx_runtime.rate_buckets
        where window_start_ms < v_window_start - (p_window_ms * 2);
      return false;
    end if;
  end loop;

  -- Keep only a short rolling history of bucket metadata; event and mailbox data
  -- are not affected by this cleanup.
  delete from skillx_runtime.rate_buckets
    where window_start_ms < v_window_start - (p_window_ms * 2);
  return true;
end;
$;

create or replace function public.skillx_runtime_mailbox_get_key(p_mailbox_id text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'v', 1,
    'identity_pubkey', k.identity_pubkey,
    'x_pubkey', k.x_pubkey,
    'created_at', k.created_at,
    'sig', k.sig
  )
  from skillx_runtime.mailbox_keys as k
  where k.mailbox_id = p_mailbox_id;
$$;

create or replace function public.skillx_runtime_mailbox_put_key(
  p_mailbox_id text,
  p_identity_pubkey text,
  p_x_pubkey text,
  p_created_at text,
  p_sig text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing skillx_runtime.mailbox_keys%rowtype;
  v_count bigint;
begin
  if p_mailbox_id !~ '^[0-9a-f]{64}$' or p_identity_pubkey is null
     or p_x_pubkey is null or p_created_at is null or p_sig is null then
    raise exception 'invalid mailbox key arguments' using errcode = '22023';
  end if;

  perform 1 from skillx_runtime.write_guard where id = 1 for update;
  select * into v_existing from skillx_runtime.mailbox_keys
    where mailbox_id = p_mailbox_id for update;

  if not found then
    select count(*) into v_count from skillx_runtime.mailbox_keys;
    if v_count >= 10000 then
      raise exception 'too many mailboxes' using errcode = 'P0001';
    end if;
    insert into skillx_runtime.mailbox_keys(mailbox_id, identity_pubkey, x_pubkey, created_at, sig)
    values (p_mailbox_id, p_identity_pubkey, p_x_pubkey, p_created_at, p_sig);
    insert into skillx_runtime.mailbox_counters(mailbox_id, last_seq) values (p_mailbox_id, 0);
    return 'created';
  end if;

  if p_created_at > v_existing.created_at then
    update skillx_runtime.mailbox_keys
    set identity_pubkey = p_identity_pubkey, x_pubkey = p_x_pubkey,
        created_at = p_created_at, sig = p_sig
    where mailbox_id = p_mailbox_id;
    return 'replaced';
  end if;
  if p_created_at = v_existing.created_at then
    return 'unchanged';
  end if;
  raise exception 'key bundle is older than stored one' using errcode = '23505';
end;
$$;

create or replace function public.skillx_runtime_mailbox_add_message(
  p_mailbox_id text,
  p_message_id text,
  p_envelope jsonb,
  p_stored_at bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_next_seq bigint;
  v_count bigint;
begin
  if p_mailbox_id !~ '^[0-9a-f]{64}$'
     or p_message_id !~ '^[0-9a-f]{32}$'
     or p_envelope is null or p_stored_at is null or p_stored_at < 0 then
    raise exception 'invalid mailbox message arguments' using errcode = '22023';
  end if;

  -- Serialize message posting per mailbox, not globally across all mailboxes.
  perform 1 from skillx_runtime.mailbox_counters
    where mailbox_id = p_mailbox_id for update;
  if not found then
    raise exception 'no key bundle for mailbox' using errcode = 'P0002';
  end if;

  delete from skillx_runtime.mailbox_messages
    where mailbox_id = p_mailbox_id
      and p_stored_at - stored_at >= 1209600000;
  delete from skillx_runtime.mailbox_post_log
    where mailbox_id = p_mailbox_id
      and p_stored_at - posted_at >= 60000;

  select count(*) into v_count from skillx_runtime.mailbox_post_log
    where mailbox_id = p_mailbox_id;
  if v_count >= 60 then
    raise exception 'too many posts per minute' using errcode = 'P0001';
  end if;

  select count(*) into v_count from skillx_runtime.mailbox_messages
    where mailbox_id = p_mailbox_id;
  if v_count >= 200 then
    raise exception 'mailbox is full' using errcode = 'P0001';
  end if;

  update skillx_runtime.mailbox_counters
    set last_seq = last_seq + 1
    where mailbox_id = p_mailbox_id
    returning last_seq into v_next_seq;
  if not found then
    raise exception 'mailbox sequence counter is missing' using errcode = '55000';
  end if;

  insert into skillx_runtime.mailbox_messages(mailbox_id, seq, id, envelope, stored_at)
    values (p_mailbox_id, v_next_seq, p_message_id, p_envelope, p_stored_at);
  insert into skillx_runtime.mailbox_post_log(mailbox_id, posted_at)
    values (p_mailbox_id, p_stored_at);

  return jsonb_build_object('id', p_message_id);
end;
$$;

create or replace function public.skillx_runtime_mailbox_list_messages(
  p_mailbox_id text,
  p_after bigint,
  p_limit integer,
  p_now bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_messages jsonb;
  v_next bigint;
begin
  if p_after is null or p_after < 0 or p_limit is null or p_limit < 1 or p_limit > 100
     or p_now is null or p_now < 0 then
    raise exception 'invalid mailbox query' using errcode = '22023';
  end if;

  -- A mailbox-local counter lock keeps this cleanup consistent with concurrent posts
  -- without serializing unrelated mailboxes or relay-ledger writes.
  perform 1 from skillx_runtime.mailbox_counters
    where mailbox_id = p_mailbox_id for update;
  delete from skillx_runtime.mailbox_messages
    where mailbox_id = p_mailbox_id
      and p_now - stored_at >= 1209600000;

  select coalesce(
    jsonb_agg(jsonb_build_object(
      'seq', q.seq, 'id', q.id, 'envelope', q.envelope, 'stored_at', q.stored_at
    ) order by q.seq),
    '[]'::jsonb
  ), coalesce(max(q.seq), p_after)
    into v_messages, v_next
    from (
      select m.seq, m.id, m.envelope, m.stored_at
      from skillx_runtime.mailbox_messages as m
      where m.mailbox_id = p_mailbox_id and m.seq > p_after
      order by m.seq
      limit p_limit
    ) as q;
  return jsonb_build_object('messages', v_messages, 'next', v_next);
end;
$$;

create or replace function public.skillx_runtime_mailbox_delete_message(
  p_mailbox_id text,
  p_message_id text,
  p_now bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_now is null or p_now < 0 then
    raise exception 'invalid timestamp' using errcode = '22023';
  end if;

  -- Serialize deletion with inserts for this mailbox only.
  perform 1 from skillx_runtime.mailbox_counters
    where mailbox_id = p_mailbox_id for update;
  delete from skillx_runtime.mailbox_messages
    where mailbox_id = p_mailbox_id and p_now - stored_at >= 1209600000;
  delete from skillx_runtime.mailbox_messages
    where mailbox_id = p_mailbox_id and id = p_message_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- The runtime schema is private. Only the server-side Vercel service role can access its tables.
revoke all on function public.skillx_runtime_rate_limit(text[], integer[], bigint, bigint) from public, anon, authenticated;
revoke all on function public.skillx_runtime_ledger_load() from public, anon, authenticated;
revoke all on function public.skillx_runtime_ledger_append(bigint, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.skillx_runtime_mailbox_get_key(text) from public, anon, authenticated;
revoke all on function public.skillx_runtime_mailbox_put_key(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.skillx_runtime_mailbox_add_message(text, text, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.skillx_runtime_mailbox_list_messages(text, bigint, integer, bigint) from public, anon, authenticated;
revoke all on function public.skillx_runtime_mailbox_delete_message(text, text, bigint) from public, anon, authenticated;

grant execute on function public.skillx_runtime_rate_limit(text[], integer[], bigint, bigint) to service_role;
grant execute on function public.skillx_runtime_ledger_load() to service_role;
grant execute on function public.skillx_runtime_ledger_append(bigint, text, text, text, text, text) to service_role;
grant execute on function public.skillx_runtime_mailbox_get_key(text) to service_role;
grant execute on function public.skillx_runtime_mailbox_put_key(text, text, text, text, text) to service_role;
grant execute on function public.skillx_runtime_mailbox_add_message(text, text, jsonb, bigint) to service_role;
grant execute on function public.skillx_runtime_mailbox_list_messages(text, bigint, integer, bigint) to service_role;
grant execute on function public.skillx_runtime_mailbox_delete_message(text, text, bigint) to service_role;

commit;
