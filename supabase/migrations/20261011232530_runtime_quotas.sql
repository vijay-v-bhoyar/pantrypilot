-- Service-only, account-wide fixed-window admission across application instances.
create table public.runtime_quotas (
 quota_key text not null, window_seconds integer not null,
 window_id bigint not null, used integer not null, expires_at timestamptz not null,
 primary key(quota_key, window_seconds, window_id),
 check (length(quota_key) between 1 and 128),
 check (window_seconds between 1 and 86400), check (used >= 0)
);
alter table public.runtime_quotas enable row level security;
revoke all on public.runtime_quotas from public, anon, authenticated;
grant all on public.runtime_quotas to service_role;

create function public.reserve_runtime_quota(buckets jsonb) returns boolean
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare b jsonb; window_number bigint; current_usage integer;
begin
 if jsonb_typeof(buckets) is distinct from 'array' then raise exception 'Invalid quota policy'; end if;
 if jsonb_array_length(buckets) not between 1 and 8 then raise exception 'Invalid quota policy'; end if;
 if (select count(distinct value->>'key') from jsonb_array_elements(buckets)) <> jsonb_array_length(buckets)
 then raise exception 'Duplicate quota key'; end if;
 for b in select value from jsonb_array_elements(buckets) loop
   if jsonb_typeof(b) is distinct from 'object'
      or coalesce(b->>'key','') !~ '^[a-zA-Z0-9:_-]{1,128}$'
      or jsonb_typeof(b->'limit') is distinct from 'number'
      or jsonb_typeof(b->'windowSeconds') is distinct from 'number'
      or (b->>'limit')::numeric <> trunc((b->>'limit')::numeric)
      or (b->>'windowSeconds')::numeric <> trunc((b->>'windowSeconds')::numeric)
      or (b->>'limit')::numeric not between 1 and 10000
      or (b->>'windowSeconds')::numeric not between 1 and 86400
   then raise exception 'Invalid quota policy'; end if;
 end loop;
 -- Single short transaction lock avoids oversubscription and partial bucket reservation.
 perform pg_advisory_xact_lock(736012950::bigint);
 delete from public.runtime_quotas where expires_at <= now();
 for b in select value from jsonb_array_elements(buckets) loop
   window_number := floor(extract(epoch from now()) / (b->>'windowSeconds')::numeric::integer)::bigint;
   select used into current_usage from public.runtime_quotas
    where quota_key=b->>'key' and window_seconds=(b->>'windowSeconds')::numeric::integer and window_id=window_number;
   if coalesce(current_usage,0) >= (b->>'limit')::numeric::integer then return false; end if;
 end loop;
 for b in select value from jsonb_array_elements(buckets) loop
   window_number := floor(extract(epoch from now()) / (b->>'windowSeconds')::numeric::integer)::bigint;
   insert into public.runtime_quotas values(b->>'key', (b->>'windowSeconds')::numeric::integer,
    window_number, 1, to_timestamp((window_number+1)*(b->>'windowSeconds')::numeric::integer))
   on conflict(quota_key,window_seconds,window_id) do update set used=runtime_quotas.used+1;
 end loop;
 return true;
end $$;
revoke all on function public.reserve_runtime_quota(jsonb) from public,anon,authenticated;
grant execute on function public.reserve_runtime_quota(jsonb) to service_role;
