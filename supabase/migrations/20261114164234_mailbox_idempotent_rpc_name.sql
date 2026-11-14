-- Supabase's PostgREST RPC interface does not support overloaded function names.
-- Give the idempotent six-argument mailbox writer its own unique RPC name.

begin;

alter function public.skillx_runtime_mailbox_add_message(
  text, text, jsonb, bigint, text, text
) rename to skillx_runtime_mailbox_add_message_idempotent;

revoke all on function public.skillx_runtime_mailbox_add_message_idempotent(
  text, text, jsonb, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.skillx_runtime_mailbox_add_message_idempotent(
  text, text, jsonb, bigint, text, text
) to service_role;

commit;
