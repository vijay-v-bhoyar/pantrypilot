-- Atomic aggregate persistence for bounded hackathon workspaces. Service role only.
create table if not exists public.workspaces (
 id uuid primary key, owner_id text not null, demo boolean not null default false,
 revision bigint not null default 0, payload jsonb not null,
 lease_id uuid, lease_until timestamptz, updated_at timestamptz not null default now(),
 check (jsonb_typeof(payload)='object'), check (payload->>'id'=id::text)
);
alter table public.workspaces enable row level security;
revoke all on public.workspaces from anon, authenticated;
create or replace function public.claim_workspace(workspace_id uuid, lease_id uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 update workspaces w set lease_id=claim_workspace.lease_id, lease_until=now()+interval '120 seconds'
 where w.id=workspace_id and (w.lease_until is null or w.lease_until<now()) returning payload into result;
 return result;
end $$;
create or replace function public.save_workspace(workspace_id uuid, lease_id uuid, new_payload jsonb) returns boolean
language plpgsql security definer set search_path=public as $$
begin
 update workspaces w set payload=new_payload, revision=(new_payload->>'revision')::bigint, updated_at=now()
 where w.id=workspace_id and w.lease_id=save_workspace.lease_id and w.lease_until>now()
 and (new_payload->>'revision')::bigint=w.revision+1 and new_payload->>'id'=w.id::text;
 return found;
end $$;
create or replace function public.release_workspace(workspace_id uuid, lease_id uuid) returns void
language sql security definer set search_path=public as $$
 update workspaces w set lease_id=null,lease_until=null where w.id=workspace_id and w.lease_id=release_workspace.lease_id;
$$;
revoke all on function public.claim_workspace(uuid,uuid), public.save_workspace(uuid,uuid,jsonb), public.release_workspace(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_workspace(uuid,uuid), public.save_workspace(uuid,uuid,jsonb), public.release_workspace(uuid,uuid) to service_role;
grant all on public.workspaces to service_role;
create table if not exists public.memberships (
 user_id uuid not null references auth.users(id) on delete cascade,
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 actor_id text not null, created_at timestamptz not null default now(),
 primary key(user_id,workspace_id)
);
alter table public.memberships enable row level security;
revoke all on public.memberships from anon,authenticated;
grant all on public.memberships to service_role;
