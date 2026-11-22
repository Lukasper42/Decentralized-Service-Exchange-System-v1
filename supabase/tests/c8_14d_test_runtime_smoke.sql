-- Read-only smoke assertions for the isolated C8 14-day test runtime.
-- Run after applying 20261122165042_skillx_c8_14d_test_runtime.sql.

do $$
declare
  v_rows bigint;
  v_rls boolean;
begin
  if to_regclass('skillx_c8_14d_test.ledger_entries') is null
     or to_regclass('skillx_c8_14d_test.rate_buckets') is null
     or to_regclass('skillx_c8_14d_test.write_guard') is null then
    raise exception 'C8 14-day test runtime tables are missing';
  end if;

  select count(*) into v_rows
  from skillx_c8_14d_test.ledger_entries;
  if v_rows <> 0 then
    raise exception 'C8 14-day test ledger must start empty; found % rows', v_rows;
  end if;

  select c.relrowsecurity into v_rls
  from pg_class c
  where c.oid = 'skillx_c8_14d_test.ledger_entries'::regclass;
  if v_rls is distinct from true then
    raise exception 'RLS is not enabled on the test ledger';
  end if;

  if not has_schema_privilege('service_role', 'skillx_c8_14d_test', 'USAGE')
     or has_schema_privilege('anon', 'skillx_c8_14d_test', 'USAGE')
     or has_schema_privilege('authenticated', 'skillx_c8_14d_test', 'USAGE') then
    raise exception 'Test schema grants are not restricted to service_role';
  end if;

  if not has_table_privilege('service_role', 'skillx_c8_14d_test.ledger_entries', 'SELECT')
     or not has_table_privilege('service_role', 'skillx_c8_14d_test.ledger_entries', 'INSERT')
     or has_table_privilege('anon', 'skillx_c8_14d_test.ledger_entries', 'SELECT')
     or has_table_privilege('authenticated', 'skillx_c8_14d_test.ledger_entries', 'SELECT') then
    raise exception 'Test ledger table grants are not restricted';
  end if;

  if not has_function_privilege('service_role', 'public.skillx_c8_14d_test_ledger_load()', 'EXECUTE')
     or has_function_privilege('anon', 'public.skillx_c8_14d_test_ledger_load()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.skillx_c8_14d_test_ledger_load()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.skillx_c8_14d_test_ledger_append(bigint,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.skillx_c8_14d_test_ledger_append(bigint,text,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.skillx_c8_14d_test_rate_limit(text[],integer[],bigint,bigint)', 'EXECUTE')
     or has_function_privilege('anon', 'public.skillx_c8_14d_test_rate_limit(text[],integer[],bigint,bigint)', 'EXECUTE') then
    raise exception 'Test RPC function grants are not restricted to service_role';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'skillx_c8_14d_test_ledger_load',
        'skillx_c8_14d_test_ledger_append',
        'skillx_c8_14d_test_rate_limit'
      )
      and p.prosecdef
  ) then
    raise exception 'C8 14-day RPC functions must remain SECURITY INVOKER';
  end if;
end;
$$;
