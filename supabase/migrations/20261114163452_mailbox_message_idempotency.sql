-- Adds atomic, request-keyed idempotency to serverless mailbox message posts.
-- The legacy four-argument RPC is retained for old Preview instances during rollout.

begin;

create table skillx_runtime.mailbox_idempotency (
  mailbox_id text not null
    references skillx_runtime.mailbox_keys(mailbox_id) on delete cascade,
  idempotency_key text not null
    check (idempotency_key ~ '^[0-9a-f]{32}$'),
  request_hash text not null
    check (request_hash ~ '^[0-9a-f]{64}$'),
  message_id text not null
    check (message_id ~ '^[0-9a-f]{32}$'),
  created_at bigint not null
    check (created_at >= 0),
  constraint mailbox_idempotency_pkey primary key (mailbox_id, idempotency_key)
);

create index mailbox_idempotency_ttl
  on skillx_runtime.mailbox_idempotency (mailbox_id, created_at);

alter table skillx_runtime.mailbox_idempotency enable row level security;
revoke all on table skillx_runtime.mailbox_idempotency from public, anon, authenticated;
grant all on table skillx_runtime.mailbox_idempotency to service_role;

create function public.skillx_runtime_mailbox_add_message(
  p_mailbox_id text,
  p_message_id text,
  p_envelope jsonb,
  p_stored_at bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_next_seq bigint;
  v_count bigint;
  v_existing_hash text;
  v_existing_message_id text;
begin
  if p_mailbox_id is null or p_mailbox_id !~ '^[0-9a-f]{64}$'
     or p_message_id is null or p_message_id !~ '^[0-9a-f]{32}$'
     or p_envelope is null
     or p_stored_at is null or p_stored_at < 0
     or ((p_idempotency_key is null) <> (p_request_hash is null))
     or (p_idempotency_key is not null and p_idempotency_key !~ '^[0-9a-f]{32}$')
     or (p_request_hash is not null and p_request_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid mailbox message arguments' using errcode = '22023';
  end if;

  -- Serialize sends for this mailbox so a concurrent retry sees the first committed result.
  perform 1 from skillx_runtime.mailbox_counters
    where mailbox_id = p_mailbox_id for update;
  if not found then
    raise exception 'no key bundle for mailbox' using errcode = 'P0002';
  end if;

  if p_idempotency_key is not null then
    delete from skillx_runtime.mailbox_idempotency
      where mailbox_id = p_mailbox_id
        and p_stored_at - created_at >= 1209600000;

    select request_hash, message_id
      into v_existing_hash, v_existing_message_id
      from skillx_runtime.mailbox_idempotency
      where mailbox_id = p_mailbox_id
        and idempotency_key = p_idempotency_key;

    if found then
      if v_existing_hash <> p_request_hash then
        raise exception 'idempotency key reused with different content' using errcode = '23505';
      end if;
      return jsonb_build_object('id', v_existing_message_id, 'duplicate', true);
    end if;
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

  if p_idempotency_key is not null then
    insert into skillx_runtime.mailbox_idempotency(
      mailbox_id, idempotency_key, request_hash, message_id, created_at
    ) values (
      p_mailbox_id, p_idempotency_key, p_request_hash, p_message_id, p_stored_at
    );
  end if;

  return jsonb_build_object('id', p_message_id, 'duplicate', false);
end;
$function$;

revoke all on function public.skillx_runtime_mailbox_add_message(
  text, text, jsonb, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.skillx_runtime_mailbox_add_message(
  text, text, jsonb, bigint, text, text
) to service_role;

commit;
