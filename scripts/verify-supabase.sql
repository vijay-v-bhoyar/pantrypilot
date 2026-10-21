-- Run only in the designated synthetic sandbox. All fixture changes roll back.
begin;
set local role service_role;
do $qualification$
declare
  workspace_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  first_lease uuid := gen_random_uuid();
  second_lease uuid := gen_random_uuid();
  initial jsonb;
  current_lease uuid;
  forbidden_role text;
  saved_revision bigint;
begin
  initial := jsonb_build_object('id', workspace_id::text, 'revision', 0);
  insert into public.workspaces(id, owner_id, demo, revision, payload)
    values(workspace_id, 'sandbox-qualification', true, 0, initial);

  if public.claim_workspace(workspace_id, first_lease) is distinct from initial then
    raise exception 'Initial lease must return the persisted payload';
  end if;
  if public.claim_workspace(workspace_id, second_lease) is not null then
    raise exception 'A competing lease must not be admitted';
  end if;
  if public.save_workspace(workspace_id, second_lease, initial || '{"revision":1}') then
    raise exception 'Wrong lease must not save';
  end if;
  if public.save_workspace(workspace_id, first_lease, initial) then
    raise exception 'Unchanged revision must not save';
  end if;
  if public.save_workspace(workspace_id, first_lease,
      jsonb_build_object('id',other_id::text,'revision',1)) then
    raise exception 'A mismatched payload identity must not save';
  end if;
  if not public.save_workspace(workspace_id, first_lease, initial || '{"revision":1}') then
    raise exception 'Valid lease and next revision must save';
  end if;
  if public.save_workspace(workspace_id, first_lease, initial || '{"revision":1}') then
    raise exception 'Stale revision replay must not save';
  end if;

  update public.workspaces set lease_until=now()-interval '1 second' where id=workspace_id;
  if public.save_workspace(workspace_id, first_lease, initial || '{"revision":2}') then
    raise exception 'Expired lease must not save';
  end if;
  if public.claim_workspace(workspace_id, second_lease) is distinct from (initial || '{"revision":1}') then
    raise exception 'A new lease must recover the expired lease and latest state';
  end if;
  perform public.release_workspace(workspace_id, first_lease);
  select w.lease_id into current_lease from public.workspaces w where w.id=workspace_id;
  if current_lease is distinct from second_lease then
    raise exception 'An old lease must not release a newer lease';
  end if;
  if not public.save_workspace(workspace_id, second_lease, initial || '{"revision":2}') then
    raise exception 'Recovered lease must save the next revision';
  end if;
  perform public.release_workspace(workspace_id, second_lease);
  select w.revision into saved_revision from public.workspaces w where w.id=workspace_id;
  if saved_revision is distinct from 2 then
    raise exception 'The confirmed revision must persist';
  end if;
  if public.claim_workspace(workspace_id, first_lease) is distinct from (initial || '{"revision":2}') then
    raise exception 'Released workspace must be claimable with latest payload';
  end if;

  foreach forbidden_role in array array['anon','authenticated'] loop
    perform set_config('role',forbidden_role,true);
    begin
      perform 1 from public.workspaces limit 1;
      raise exception 'Client role incorrectly has workspace read access';
    exception when insufficient_privilege then null;
    end;
    begin
      perform 1 from public.memberships limit 1;
      raise exception 'Client role incorrectly has membership read access';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.claim_workspace(workspace_id,first_lease);
      raise exception 'Client role incorrectly has privileged RPC access';
    exception when insufficient_privilege then null;
    end;
  end loop;
end
$qualification$;
rollback;
select 'PASS' as sandbox_storage_qualification;
