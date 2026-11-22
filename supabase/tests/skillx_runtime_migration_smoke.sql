-- Integration smoke tests for the complete SkillX migration chain.
-- This file is executed only against the disposable PostgreSQL service in CI.

begin;

do $$
declare
  v_archive_tables integer;
  v_runtime_tables integer;
begin
  select count(*) into v_archive_tables
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='skillx'
    and c.relkind='r'
    and c.relname in ('documents','incidents','knowledge_base','tasks','attachment_manifest')
    and c.relrowsecurity;

  if v_archive_tables <> 5 then
    raise exception 'Notion archive must contain five RLS-protected tables';
  end if;

  if exists (select 1 from pg_policies where schemaname='skillx') then
    raise exception 'Notion archive must not have public RLS policies';
  end if;

  if has_schema_privilege('anon','skillx','USAGE')
     or has_schema_privilege('authenticated','skillx','USAGE')
     or has_schema_privilege('service_role','skillx','USAGE') then
    raise exception 'Notion archive schema must remain private';
  end if;

  select count(*) into v_runtime_tables
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='skillx_runtime'
    and c.relkind='r'
    and c.relname in (
      'ledger_entries','rate_buckets','write_guard','mailbox_keys',
      'mailbox_counters','mailbox_messages','mailbox_post_log','mailbox_idempotency'
    )
    and c.relrowsecurity;

  if v_runtime_tables <> 8 then
    raise exception 'Runtime schema must contain eight RLS-protected tables';
  end if;

  if exists (select 1 from pg_policies where schemaname='skillx_runtime') then
    raise exception 'Private runtime schema must not have RLS policies';
  end if;

  if has_schema_privilege('anon','skillx_runtime','USAGE')
     or has_schema_privilege('authenticated','skillx_runtime','USAGE') then
    raise exception 'Public roles must not have runtime schema usage';
  end if;

  if not has_schema_privilege('service_role','skillx_runtime','USAGE') then
    raise exception 'service_role must have runtime schema usage';
  end if;

  if not has_table_privilege('service_role','skillx_runtime.mailbox_idempotency','SELECT')
     or not has_table_privilege('service_role','skillx_runtime.mailbox_idempotency','INSERT')
     or not has_table_privilege('service_role','skillx_runtime.mailbox_idempotency','DELETE') then
    raise exception 'service_role mailbox idempotency grants are incomplete';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.skillx_runtime_mailbox_add_message_idempotent(text,text,jsonb,bigint,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.skillx_runtime_mailbox_add_message_idempotent(text,text,jsonb,bigint,text,text)',
       'EXECUTE'
     ) then
    raise exception 'idempotent mailbox RPC permissions are incorrect';
  end if;

  if to_regprocedure('public.skillx_runtime_mailbox_add_message(text,text,jsonb,bigint)') is null
     or to_regprocedure('public.skillx_runtime_mailbox_add_message_idempotent(text,text,jsonb,bigint,text,text)') is null then
    raise exception 'legacy or idempotent mailbox RPC is missing';
  end if;
end;
$$;

set local role service_role;

do $$
declare
  v_key_status text;
  v_first jsonb;
  v_retry jsonb;
  v_legacy jsonb;
begin
  v_key_status := public.skillx_runtime_mailbox_put_key(
    repeat('1',64),
    'ci-identity-key',
    'ci-x-key',
    '2026-01-01T00:00:00.000Z',
    'ci-signature'
  );

  if v_key_status <> 'created' then
    raise exception 'mailbox test key was not created';
  end if;

  v_first := public.skillx_runtime_mailbox_add_message_idempotent(
    repeat('1',64),
    repeat('2',32),
    '{"content":"smoke"}'::jsonb,
    100000,
    repeat('3',32),
    repeat('4',64)
  );

  if v_first->>'duplicate' <> 'false' or v_first->>'id' <> repeat('2',32) then
    raise exception 'first idempotent message result is incorrect: %', v_first;
  end if;

  v_retry := public.skillx_runtime_mailbox_add_message_idempotent(
    repeat('1',64),
    repeat('5',32),
    '{"content":"smoke"}'::jsonb,
    100001,
    repeat('3',32),
    repeat('4',64)
  );

  if v_retry->>'duplicate' <> 'true' or v_retry->>'id' <> repeat('2',32) then
    raise exception 'idempotent retry did not return the original message: %', v_retry;
  end if;

  begin
    perform public.skillx_runtime_mailbox_add_message_idempotent(
      repeat('1',64),
      repeat('6',32),
      '{"content":"different"}'::jsonb,
      100002,
      repeat('3',32),
      repeat('7',64)
    );
    raise exception 'reused idempotency key with changed request unexpectedly succeeded';
  exception
    when sqlstate '23505' then null;
  end;

  v_legacy := public.skillx_runtime_mailbox_add_message(
    repeat('1',64),
    repeat('8',32),
    '{"content":"legacy"}'::jsonb,
    100003
  );

  if v_legacy->>'id' <> repeat('8',32) then
    raise exception 'legacy four-argument mailbox RPC failed: %', v_legacy;
  end if;

  if (select count(*) from skillx_runtime.mailbox_messages) <> 2 then
    raise exception 'mailbox must contain exactly two non-duplicate messages';
  end if;

  if (select count(*) from skillx_runtime.mailbox_idempotency) <> 1 then
    raise exception 'mailbox idempotency table must contain exactly one key';
  end if;
end;
$$;

reset role;

rollback;
