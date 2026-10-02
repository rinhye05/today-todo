create table if not exists public.todo_documents (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  tasks jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.todo_documents enable row level security;
revoke all on table public.todo_documents from anon, authenticated;
grant select, insert, update, delete on table public.todo_documents to authenticated;

drop policy if exists "Users can read their own todo document" on public.todo_documents;
create policy "Users can read their own todo document"
  on public.todo_documents for select to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "Users can insert their own todo document" on public.todo_documents;
create policy "Users can insert their own todo document"
  on public.todo_documents for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can update their own todo document" on public.todo_documents;
create policy "Users can update their own todo document"
  on public.todo_documents for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Users can delete their own todo document" on public.todo_documents;
create policy "Users can delete their own todo document"
  on public.todo_documents for delete to authenticated
  using ((select auth.uid()) = owner_id);

create or replace function public.touch_todo_document_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists todo_documents_updated_at on public.todo_documents;
create trigger todo_documents_updated_at
  before update on public.todo_documents
  for each row execute function public.touch_todo_document_updated_at();
