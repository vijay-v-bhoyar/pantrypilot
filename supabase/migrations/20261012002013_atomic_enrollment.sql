-- Enrollment writes are one service-only transaction, never two REST mutations.
create function public.bootstrap_owned_workspace(member_user_id uuid, initial_payload jsonb) returns jsonb
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare existing public.memberships%rowtype; owner_actor jsonb; workspace_uuid uuid;
begin
 if member_user_id is null then raise exception 'Verified user required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(member_user_id::text,1));
 select * into existing from public.memberships m where m.user_id=member_user_id
 order by m.created_at,m.workspace_id limit 1;
 if found then return jsonb_build_object('workspace_id',existing.workspace_id,'actor_id',existing.actor_id,'created',false); end if;
 if jsonb_typeof(initial_payload) is distinct from 'object'
    or initial_payload->>'ownerId' is distinct from member_user_id::text
    or initial_payload->>'demo' is distinct from 'false'
    or (initial_payload->>'revision')::bigint is distinct from 0
    or jsonb_typeof(initial_payload->'actors') is distinct from 'array'
    or jsonb_typeof(initial_payload->'organizations') is distinct from 'array'
 then raise exception 'Invalid owner workspace'; end if;
 if jsonb_array_length(initial_payload->'actors') <> 1 then raise exception 'Single owner required'; end if;
 owner_actor := initial_payload->'actors'->0;
 if owner_actor->>'role' is distinct from 'owner' or length(coalesce(owner_actor->>'id','')) not between 1 and 80
    or not exists(select 1 from jsonb_array_elements(initial_payload->'organizations') o where o->>'id'=owner_actor->>'organizationId')
 then raise exception 'Invalid owner actor'; end if;
 workspace_uuid := (initial_payload->>'id')::uuid;
 insert into public.workspaces(id,owner_id,demo,revision,payload)
 values(workspace_uuid,member_user_id::text,false,0,initial_payload);
 insert into public.memberships(user_id,workspace_id,actor_id)
 values(member_user_id,workspace_uuid,owner_actor->>'id');
 return jsonb_build_object('workspace_id',workspace_uuid,'actor_id',owner_actor->>'id','created',true);
end $$;

create function public.save_workspace_membership(workspace_id uuid,lease_id uuid,new_payload jsonb,
 member_user_id uuid,member_actor_id text) returns boolean
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare original_payload jsonb; previous_actor text;
begin
 if member_user_id is null or jsonb_typeof(new_payload->'actors') is distinct from 'array'
    or new_payload->>'demo' is distinct from 'false'
    or not exists(select 1 from jsonb_array_elements(new_payload->'actors') a where a->>'id'=member_actor_id)
 then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended(member_user_id::text,1));
 select w.payload into original_payload from public.workspaces w
 where w.id=workspace_id and not w.demo and w.lease_id=save_workspace_membership.lease_id
  and w.lease_until>now() and (new_payload->>'revision')::bigint=w.revision+1
  and new_payload->>'id'=w.id::text for update;
 if not found then return false; end if;
 select m.actor_id into previous_actor from public.memberships m
 where m.user_id=member_user_id and m.workspace_id=save_workspace_membership.workspace_id for update;
 -- A revoked/missing actor may re-enroll with a newly authorized invitation/campaign.
 -- An active identity is never silently rebound to a different actor.
 if previous_actor is not null and previous_actor is distinct from member_actor_id
    and exists(select 1 from jsonb_array_elements(original_payload->'actors') a where a->>'id'=previous_actor)
 then return false; end if;
 update public.workspaces w set payload=new_payload,revision=(new_payload->>'revision')::bigint,updated_at=now()
 where w.id=workspace_id;
 insert into public.memberships(user_id,workspace_id,actor_id)
 values(save_workspace_membership.member_user_id,save_workspace_membership.workspace_id,save_workspace_membership.member_actor_id)
 on conflict on constraint memberships_pkey do update set actor_id=excluded.actor_id;
 return true;
end $$;
revoke all on function public.bootstrap_owned_workspace(uuid,jsonb),public.save_workspace_membership(uuid,uuid,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.bootstrap_owned_workspace(uuid,jsonb),public.save_workspace_membership(uuid,uuid,jsonb,uuid,text) to service_role;
