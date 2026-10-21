-- Workspace membership lookup/deletion must not scan all memberships.
create index if not exists memberships_workspace_id_idx
  on public.memberships(workspace_id);

-- The dashboard's automatic-RLS event trigger is administrative only.
-- Some projects do not enable this optional platform helper.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
