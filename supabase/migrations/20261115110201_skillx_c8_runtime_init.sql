-- SkillX C8 serverless runtime schema.
-- Reconstructed from the live skillx_c8_runtime catalog and migration history
-- (version 20261115110201). This migration creates schema objects only; it
-- deliberately does not import, copy, or rewrite ledger_entries.
--
-- Keep this runtime isolated from the legacy skillx_runtime mailbox schema.
-- All ledger writes must continue to pass through the Vercel Relay RPC.

begin;

create schema if not exists skillx_c8_runtime;

revoke all on schema skillx_c8_runtime from public, anon, authenticated;
grant usage on schema skillx_c8_runtime to service_role;

create table if not exists skillx_c8_runtime.write_guard (
  id integer primary key check (id = 1)
);

-- The single lock row serializes ledger appends. It is infrastructure, not
-- a ledger event or imported business data.
insert into skillx_c8_runtime.write_guard(id)
values (1)
on conflict (id) do nothing;

create table if not exists skillx_c8_runtime.rate_buckets (
  bucket_key text not null,
  window_start_ms bigint not null check (window_start_ms >= 0),
  request_count integer not null check (request_count > 0),
  primary key (bucket_key, window_start_ms)
);

create table if not exists skillx_c8_runtime.ledger_entries (
  sequence bigint primary key check (sequence > 0),
  event_hash text not null unique check (event_hash ~ '^[0-9a-f]{64}$'),
  signer text not null,
  prev_hash text null check (prev_hash is null or prev_hash ~ '^[0-9a-f]{64}$'),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  entry_json text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists skillx_c8_runtime_ledger_signer_prev
  on skillx_c8_runtime.ledger_entries(signer, prev_hash)
  where prev_hash is not null;

create unique index if not exists skillx_c8_runtime_ledger_signer_genesis
  on skillx_c8_runtime.ledger_entries(signer)
  where prev_hash is null;

create or replace function skillx_c8_runtime.reject_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'ledger_entries is append-only' using errcode = '55000';
end;
$$;

drop trigger if exists ledger_immutable_trigger
  on skillx_c8_runtime.ledger_entries;

create trigger ledger_immutable_trigger
before update or delete on skillx_c8_runtime.ledger_entries
for each row
execute function skillx_c8_runtime.reject_ledger_mutation();

alter table skillx_c8_runtime.write_guard enable row level security;
alter table skillx_c8_runtime.rate_buckets enable row level security;
alter table skillx_c8_runtime.ledger_entries enable row level security;

revoke all on all tables in schema skillx_c8_runtime
  from public, anon, authenticated;

grant select, insert
  on skillx_c8_runtime.ledger_entries
  to service_role;

grant select, insert, update, delete
  on skillx_c8_runtime.rate_buckets
  to service_role;

grant select, update
  on skillx_c8_runtime.write_guard
  to service_role;

create or replace function public.skillx_c8_runtime_ledger_load()
returns table(sequence bigint, checksum text, entry_json text)
language sql
security invoker
set search_path = ''
as $$
  select e.sequence, e.checksum, e.entry_json
  from skillx_c8_runtime.ledger_entries as e
  order by e.sequence;
$$;

create or replace function public.skillx_c8_runtime_ledger_append(
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

  perform 1 from skillx_c8_runtime.write_guard where id = 1 for update;
  if not found then
    raise exception 'ledger write guard is missing' using errcode = '55000';
  end if;

  select coalesce(max(sequence), 0) + 1
    into v_next_sequence
    from skillx_c8_runtime.ledger_entries;
  if p_sequence <> v_next_sequence then
    raise exception 'stale ledger sequence; reload and retry' using errcode = '40001';
  end if;

  select event_hash into v_signer_tip
    from skillx_c8_runtime.ledger_entries
    where signer = p_signer
    order by sequence desc
    limit 1;
  if p_prev_hash is distinct from v_signer_tip then
    raise exception 'stale signer tip; reload and retry' using errcode = '40001';
  end if;

  insert into skillx_c8_runtime.ledger_entries(
    sequence, event_hash, signer, prev_hash, checksum, entry_json
  ) values (
    p_sequence, p_event_hash, p_signer, p_prev_hash, p_checksum, p_entry_json
  );
end;
$$;

create or replace function public.skillx_c8_runtime_rate_limit(
  p_bucket_keys text[],
  p_limits integer[],
  p_now_ms bigint,
  p_window_ms bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
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

    insert into skillx_c8_runtime.rate_buckets(
      bucket_key, window_start_ms, request_count
    )
      values (p_bucket_keys[i], v_window_start, 1)
    on conflict (bucket_key, window_start_ms)
      do update set request_count = least(
        skillx_c8_runtime.rate_buckets.request_count + 1,
        p_limits[i] + 1
      )
    returning request_count into v_count;

    if v_count > p_limits[i] then
      delete from skillx_c8_runtime.rate_buckets
        where window_start_ms < v_window_start - (p_window_ms * 2);
      return false;
    end if;
  end loop;

  delete from skillx_c8_runtime.rate_buckets
    where window_start_ms < v_window_start - (p_window_ms * 2);
  return true;
end;
$$;

revoke all on function public.skillx_c8_runtime_ledger_load()
  from public, anon, authenticated;

revoke all on function public.skillx_c8_runtime_ledger_append(
  bigint, text, text, text, text, text
) from public, anon, authenticated;

revoke all on function public.skillx_c8_runtime_rate_limit(
  text[], integer[], bigint, bigint
) from public, anon, authenticated;

grant execute on function public.skillx_c8_runtime_ledger_load()
  to service_role;

grant execute on function public.skillx_c8_runtime_ledger_append(
  bigint, text, text, text, text, text
) to service_role;

grant execute on function public.skillx_c8_runtime_rate_limit(
  text[], integer[], bigint, bigint
) to service_role;

commit;
