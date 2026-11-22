-- Create the private schema used to archive Notion-originated SkillX data.
-- This migration creates structure only; existing archive records are not seeded.

begin;

create schema if not exists skillx;

commit;
