-- Notion archive tables.
-- Data remains in the live database and is intentionally not included in migrations.
-- Keep this schema private; no grants or public policies are created.

begin;

create table if not exists skillx.documents (
  notion_page_id text primary key,
  notion_url text not null unique,
  title text not null,
  document_type text,
  parent_page_url text,
  content_markdown text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  attachment_refs jsonb not null default '[]'::jsonb,
  import_notes jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now()
);

create table if not exists skillx.incidents (
  notion_url text primary key,
  incident text not null,
  area text,
  incident_date timestamptz,
  created_at timestamptz,
  solution_workaround text,
  reference_log text,
  severity text,
  status text,
  symptom text,
  cause text,
  verification text,
  raw_properties jsonb not null default '{}'::jsonb,
  content_markdown text not null default ''
);

create table if not exists skillx.knowledge_base (
  notion_url text primary key,
  entry text not null,
  area text,
  confidentiality text,
  created_at timestamptz,
  modified_at timestamptz,
  external_url text,
  short_description text,
  file_path_repository text,
  source_evidence text,
  status text,
  last_verified_at timestamptz,
  raw_properties jsonb not null default '{}'::jsonb,
  content_markdown text not null default ''
);

create table if not exists skillx.tasks (
  notion_url text primary key,
  task text not null,
  area text,
  priority text,
  created_at timestamptz,
  due_at timestamptz,
  next_step text,
  task_type text,
  status text,
  reference_url text,
  result_evidence text,
  responsible text,
  modified_at timestamptz,
  raw_properties jsonb not null default '{}'::jsonb,
  content_markdown text not null default ''
);

create table if not exists skillx.attachment_manifest (
  id bigint generated always as identity primary key,
  notion_page_url text not null,
  notion_file_reference text not null,
  transfer_status text not null default 'reference_preserved_only',
  supabase_storage_path text,
  notes text,
  unique (notion_page_url, notion_file_reference)
);

alter table skillx.documents enable row level security;
alter table skillx.incidents enable row level security;
alter table skillx.knowledge_base enable row level security;
alter table skillx.tasks enable row level security;
alter table skillx.attachment_manifest enable row level security;

commit;
