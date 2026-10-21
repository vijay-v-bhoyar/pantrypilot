-- Designated sandbox only. Fixture counters and expiry cleanup are rolled back.
begin;
set local role service_role;
do $$
declare prefix text := 'qa:'||gen_random_uuid()::text; a jsonb; b jsonb;
        policy jsonb; rejected boolean; test_role text;
begin
 a := jsonb_build_object('key',prefix||':a','limit',2,'windowSeconds',86400);
 b := jsonb_build_object('key',prefix||':b','limit',1,'windowSeconds',86400);
 if not public.reserve_runtime_quota(jsonb_build_array(a)) then raise exception 'First reservation denied'; end if;
 if not public.reserve_runtime_quota(jsonb_build_array(a)) then raise exception 'Second reservation denied'; end if;
 if public.reserve_runtime_quota(jsonb_build_array(b,a)) then raise exception 'Exceeded limit accepted'; end if;
 if exists(select 1 from public.runtime_quotas where quota_key=prefix||':b') then raise exception 'Partial reservation charged'; end if;
 if not public.reserve_runtime_quota(jsonb_build_array(b)) then raise exception 'Independent bucket lost'; end if;
 if public.reserve_runtime_quota(jsonb_build_array(a)) then raise exception 'Replay exceeded limit'; end if;
 insert into public.runtime_quotas values(prefix||':expired',60,0,99,now()-interval '1 second');
 perform public.reserve_runtime_quota(jsonb_build_array(jsonb_build_object('key',prefix||':fresh','limit',1,'windowSeconds',60)));
 if exists(select 1 from public.runtime_quotas where quota_key=prefix||':expired') then raise exception 'Expired counter retained'; end if;
 for policy in select value from jsonb_array_elements(jsonb_build_array(
    '[]'::jsonb, '{}'::jsonb, jsonb_build_array(a,a),
    jsonb_build_array(a||'{"limit":1.5}'::jsonb),
    jsonb_build_array(a||'{"limit":0}'::jsonb),
    jsonb_build_array(a||'{"windowSeconds":86401}'::jsonb),
    jsonb_build_array(a||'{"key":"../outside"}'::jsonb),
    jsonb_build_array(a||'{"limit":"untrusted"}'::jsonb))) loop
   rejected := false;
   begin perform public.reserve_runtime_quota(policy);
   exception when others then rejected := true; end;
   if not rejected then raise exception 'Invalid policy accepted: %',policy; end if;
 end loop;
end $$;
reset role;
do $$
declare test_role text;
begin
 foreach test_role in array array['anon','authenticated'] loop
   execute format('set local role %I',test_role);
   begin
     perform 1 from public.runtime_quotas limit 1;
     raise exception 'Browser table read permitted';
   exception when insufficient_privilege then null; end;
   begin
     perform public.reserve_runtime_quota('[{"key":"qa:forbidden","limit":1,"windowSeconds":60}]'::jsonb);
     raise exception 'Browser RPC permitted';
   exception when insufficient_privilege then null; end;
   reset role;
 end loop;
end $$;
rollback;
select 'PASS' as runtime_quota_qualification;
