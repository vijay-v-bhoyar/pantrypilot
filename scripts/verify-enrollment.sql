-- Sandbox database contract only. Non-login auth UUID fixtures and all state roll back.
begin;
do $$
declare user_a uuid:=gen_random_uuid(); user_b uuid:=gen_random_uuid(); unknown_user uuid:=gen_random_uuid();
        workspace_a uuid:=gen_random_uuid(); actor_a text:=gen_random_uuid()::text;
        actor_b text:=gen_random_uuid()::text; alternate_actor text:=gen_random_uuid()::text;
        lease uuid:=gen_random_uuid(); initial jsonb; candidate jsonb; saved jsonb;
        first_binding jsonb; replay jsonb; failed boolean; test_role text;
begin
 -- No email, password or identity provider: these are FK fixtures, not usable accounts.
 insert into auth.users(id) values(user_a),(user_b);
 set local role service_role;
 initial:=jsonb_build_object('id',workspace_a,'ownerId',user_a,'revision',0,'demo',false,
  'actors',jsonb_build_array(jsonb_build_object('id',actor_a,'role','owner','organizationId','org')),
  'organizations',jsonb_build_array(jsonb_build_object('id','org')),'ledger','[]'::jsonb);
 first_binding:=public.bootstrap_owned_workspace(user_a,initial);
 if first_binding->>'created' <> 'true' then raise exception 'First bootstrap did not create'; end if;
 replay:=public.bootstrap_owned_workspace(user_a,initial||jsonb_build_object('id',gen_random_uuid()));
 if replay->>'created' <> 'false' or replay->>'workspace_id' <> workspace_a::text or replay->>'actor_id' <> actor_a
 then raise exception 'Bootstrap retry changed binding'; end if;
 if (select count(*) from public.workspaces where owner_id=user_a::text) <> 1 then raise exception 'Duplicate workspace'; end if;
 failed:=false;
 begin perform public.bootstrap_owned_workspace(unknown_user,initial||jsonb_build_object('id',gen_random_uuid(),'ownerId',unknown_user));
 exception when foreign_key_violation then failed:=true; end;
 if not failed or exists(select 1 from public.workspaces where owner_id=unknown_user::text)
 then raise exception 'Orphan workspace survived failed membership'; end if;
 perform public.claim_workspace(workspace_a,lease);
 candidate:=initial||jsonb_build_object('revision',1,'actors',(initial->'actors')||jsonb_build_array(jsonb_build_object('id',actor_b,'role','finance','organizationId','org')));
 update public.workspaces set lease_until=now()-interval '1 second' where id=workspace_a;
 if public.save_workspace_membership(workspace_a,lease,candidate,user_b,actor_b)
 then raise exception 'Expired lease accepted'; end if;
 update public.workspaces set lease_until=now()+interval '120 seconds' where id=workspace_a;
 if public.save_workspace_membership(workspace_a,lease,candidate||jsonb_build_object('id',gen_random_uuid()),user_b,actor_b)
 then raise exception 'Mismatched workspace accepted'; end if;
 if public.save_workspace_membership(workspace_a,lease,candidate||'{"demo":true}'::jsonb,user_b,actor_b)
 then raise exception 'Synthetic identity enrollment accepted'; end if;
 if exists(select 1 from public.memberships where user_id=user_b) then raise exception 'Rejected enrollment left membership'; end if;
 if public.save_workspace_membership(workspace_a,gen_random_uuid(),candidate,user_b,actor_b)
 then raise exception 'Wrong lease accepted'; end if;
 if public.save_workspace_membership(workspace_a,lease,candidate,user_b,'missing')
 then raise exception 'Missing actor accepted'; end if;
 failed:=false;
 begin perform public.save_workspace_membership(workspace_a,lease,candidate,unknown_user,actor_b);
 exception when foreign_key_violation then failed:=true; end;
 if not failed or (select revision from public.workspaces where id=workspace_a) <> 0
 then raise exception 'Aggregate committed without membership'; end if;
 if not public.save_workspace_membership(workspace_a,lease,candidate,user_b,actor_b)
 then raise exception 'Valid enrollment denied'; end if;
 if (select actor_id from public.memberships where user_id=user_b and workspace_id=workspace_a) <> actor_b
 then raise exception 'Member not bound'; end if;
 if public.save_workspace_membership(workspace_a,lease,candidate,user_b,actor_b)
 then raise exception 'Stale revision accepted'; end if;
 candidate:=candidate||jsonb_build_object('revision',2,'actors',(candidate->'actors')||jsonb_build_array(jsonb_build_object('id',alternate_actor,'role','supplier','organizationId','org')));
 if public.save_workspace_membership(workspace_a,lease,candidate,user_b,alternate_actor)
 then raise exception 'Active identity overwritten'; end if;
 if (select revision from public.workspaces where id=workspace_a) <> 1 then raise exception 'Conflict changed state'; end if;
 -- Removing an actor revokes old sessions. A newly authorized enrollment may bind a new actor.
 select payload into saved from public.workspaces where id=workspace_a;
 saved:=saved||jsonb_build_object('revision',2,'actors',initial->'actors');
 if not public.save_workspace(workspace_a,lease,saved) then raise exception 'Revocation failed'; end if;
 candidate:=saved||jsonb_build_object('revision',3,'actors',(saved->'actors')||jsonb_build_array(jsonb_build_object('id',alternate_actor,'role','donor','organizationId','org')));
 if not public.save_workspace_membership(workspace_a,lease,candidate,user_b,alternate_actor)
 then raise exception 'Authorized re-enrollment of revoked actor denied'; end if;
 if (select actor_id from public.memberships where user_id=user_b and workspace_id=workspace_a) <> alternate_actor
 then raise exception 'Re-enrollment not bound'; end if;
 foreach test_role in array array['anon','authenticated'] loop
  execute format('set local role %I',test_role);
  begin perform public.bootstrap_owned_workspace(user_a,initial); raise exception 'Browser bootstrap allowed';
  exception when insufficient_privilege then null; end;
  begin perform public.save_workspace_membership(workspace_a,lease,candidate,user_b,alternate_actor); raise exception 'Browser enrollment allowed';
  exception when insufficient_privilege then null; end;
  reset role;
 end loop;
end $$;
rollback;
select 'PASS' as atomic_enrollment_qualification;
