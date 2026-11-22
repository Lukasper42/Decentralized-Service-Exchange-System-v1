-- Smoke tests for the isolated C8 runtime migration.
-- Runs only against a disposable PostgreSQL service in GitHub Actions.

begin;

do $$
declare
  v_rls_count integer;
begin
  select count(*) into v_rls_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'skillx_c8_runtime'
    and c.relname in ('ledger_entries', 'rate_buckets', 'write_guard')
    and c.relrowsecurity;

  if v_rls_count <> 3 then
    raise exception 'RLS must be enabled on all three C8 tables';
  end if;

  if exists (
    select 1 from pg_policies where schemaname = 'skillx_c8_runtime'
  ) then
    raise exception 'C8 private schema unexpectedly has RLS policies';
  end if;

  if has_schema_privilege('anon', 'skillx_c8_runtime', 'USAGE') then
    raise exception 'anon must not have C8 schema usage';
  end if;

  if has_schema_privilege('authenticated', 'skillx_c8_runtime', 'USAGE') then
    raise exception 'authenticated must not have C8 schema usage';
  end if;

  if not has_schema_privilege('service_role', 'skillx_c8_runtime', 'USAGE') then
    raise exception 'service_role must have C8 schema usage';
  end if;

  if not has_table_privilege('service_role', 'skillx_c8_runtime.ledger_entries', 'SELECT')
     or not has_table_privilege('service_role', 'skillx_c8_runtime.ledger_entries', 'INSERT')
     or has_table_privilege('service_role', 'skillx_c8_runtime.ledger_entries', 'UPDATE')
     or has_table_privilege('service_role', 'skillx_c8_runtime.ledger_entries', 'DELETE') then
    raise exception 'ledger_entries grants are not least-privilege';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.skillx_c8_runtime_ledger_append(bigint,text,text,text,text,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.skillx_c8_runtime_ledger_append(bigint,text,text,text,text,text)',
       'EXECUTE'
     ) then
    raise exception 'C8 append RPC grants are incorrect';
  end if;

  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'skillx_c8_runtime'
      and c.relname = 'ledger_entries'
      and t.tgname = 'ledger_immutable_trigger'
      and not t.tgisinternal
      and t.tgenabled = 'O'
  ) then
    raise exception 'append-only ledger trigger is missing or disabled';
  end if;
end;
$$;

set local role service_role;

select public.skillx_c8_runtime_ledger_append(
  1, repeat('a', 64), 'ci-signer', null, repeat('b', 64), '{"test":"first"}'
);

select public.skillx_c8_runtime_ledger_append(
  2, repeat('c', 64), 'ci-signer', repeat('a', 64), repeat('d', 64), '{"test":"second"}'
);

do $$
begin
  if (select count(*) from skillx_c8_runtime.ledger_entries) <> 2 then
    raise exception 'ledger append RPC did not insert exactly two test rows';
  end if;

  if (select count(*) from public.skillx_c8_runtime_ledger_load()) <> 2 then
    raise exception 'ledger load RPC did not return both test rows';
  end if;

  if public.skillx_c8_runtime_rate_limit(
       array['ci-migration-smoke-bucket'], array[1], 10000, 1000
     ) is distinct from true then
    raise exception 'first rate-limit request should be allowed';
  end if;

  if public.skillx_c8_runtime_rate_limit(
       array['ci-migration-smoke-bucket'], array[1], 10500, 1000
     ) is distinct from false then
    raise exception 'second rate-limit request should be denied';
  end if;
end;
$$;

reset role;

do $$
begin
  begin
    update skillx_c8_runtime.ledger_entries
      set entry_json = '{"tampered":true}'
      where sequence = 1;
    raise exception 'ledger UPDATE unexpectedly succeeded';
  exception
    when sqlstate '55000' then null;
  end;

  begin
    delete from skillx_c8_runtime.ledger_entries where sequence = 1;
    raise exception 'ledger DELETE unexpectedly succeeded';
  exception
    when sqlstate '55000' then null;
  end;
end;
$$;

rollback;
