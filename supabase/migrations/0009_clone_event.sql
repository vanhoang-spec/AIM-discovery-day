-- ============================================================================
-- 0009 — clone_event (AC28)
--
-- Grand Finale 01/11 and every season after must be one action, not a
-- redeploy: copy an event's CONFIGURATION — zones, checkpoints, gift tiers,
-- special activities, thresholds — never its people or its history.
--
-- What deliberately does NOT copy:
--   * students / registrations / ledger / redemptions — one person keeps one
--     QR across the campaign; they register into the new event through the
--     normal flow, which links them (status 'linked') instead of duplicating.
--   * counters: stock_issued, golden_issued, badges — a new event starts at 0.
--   * golden_hours rows and Early Bird cutoff — tied to a specific day.
--   * is_registration_open — a clone is born CLOSED; opening it is an
--     explicit, separate decision.
--
-- Checkpoint times shift by the difference between the two events' start
-- times, so an agenda built for 12/09 lands correctly shaped on 01/11.
-- ============================================================================

create or replace function clone_event(
  p_source_id smallint,
  p_slug      text,
  p_name      text,
  p_venue     text,
  p_city      text,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_actor     text
)
returns table (new_event_id smallint, zones_copied integer, checkpoints_copied integer,
               tiers_copied integer, specials_copied integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src        events%rowtype;
  v_new_id     smallint;
  v_shift      interval;
  v_zones      integer := 0;
  v_cps        integer := 0;
  v_tiers      integer := 0;
  v_specials   integer := 0;
  v_new_checkin integer;
  v_new_eb      integer;
  r             record;
  v_zone_map    jsonb := '{}'::jsonb;   -- old zone id -> new zone id
  v_cp_map      jsonb := '{}'::jsonb;   -- old checkpoint id -> new id
  v_new_zone    integer;
  v_new_cp      integer;
  v_new_act     integer;
begin
  if p_actor is null or length(trim(p_actor)) = 0 then
    raise exception 'Cần tên người thao tác';
  end if;

  select * into v_src from events where id = p_source_id;
  if not found then
    raise exception 'Sự kiện nguồn % không tồn tại', p_source_id;
  end if;

  -- Self-defence against the explicit-id trap (bitten five times by 26/08):
  -- rows seeded or imported with explicit ids never advance the serial
  -- sequences, and this function inserts WITHOUT ids. Bump every sequence it
  -- relies on past its table's max, so a clone works no matter how the
  -- source data got in.
  perform setval(pg_get_serial_sequence('zones', 'id'),
                 (select coalesce(max(id), 0) + 1 from zones), false);
  perform setval(pg_get_serial_sequence('checkpoints', 'id'),
                 (select coalesce(max(id), 0) + 1 from checkpoints), false);
  perform setval(pg_get_serial_sequence('gift_tiers', 'id'),
                 (select coalesce(max(id), 0) + 1 from gift_tiers), false);
  perform setval(pg_get_serial_sequence('special_activities', 'id'),
                 (select coalesce(max(id), 0) + 1 from special_activities), false);

  -- events.id is the QR token byte: assigned, never serial. Take the next
  -- free byte value.
  select coalesce(max(id), 0) + 1 into v_new_id from events;
  if v_new_id > 255 then
    raise exception 'Hết chỗ id sự kiện (byte token 1..255)';
  end if;

  v_shift := p_starts_at - v_src.starts_at;

  insert into events (id, edition_id, kind, slug, name, venue_name, city,
                      starts_at, ends_at, timezone,
                      gift_ladder_mode, special_threshold_y, special_claim_limit,
                      token_key_id, is_registration_open,
                      golden_budget, golden_issued, sms_enabled)
  values (v_new_id, v_src.edition_id, v_src.kind, p_slug, p_name, p_venue, p_city,
          p_starts_at, p_ends_at, v_src.timezone,
          v_src.gift_ladder_mode, v_src.special_threshold_y, v_src.special_claim_limit,
          v_src.token_key_id, false,
          v_src.golden_budget, 0, false);

  for r in select * from zones where event_id = p_source_id order by id loop
    insert into zones (event_id, name, color_hex, display_order)
    values (v_new_id, r.name, r.color_hex, r.display_order)
    returning id into v_new_zone;
    v_zone_map := v_zone_map || jsonb_build_object(r.id::text, v_new_zone);
    v_zones := v_zones + 1;
  end loop;

  for r in select * from checkpoints where event_id = p_source_id order by id loop
    insert into checkpoints (event_id, zone_id, kind, name, description, location_hint,
                             starts_at, ends_at, capacity, counts_toward_badges,
                             badge_award_mode, allow_student_scan, display_order, is_active)
    values (v_new_id,
            case when r.zone_id is null then null
                 else (v_zone_map ->> r.zone_id::text)::integer end,
            r.kind, r.name, r.description, r.location_hint,
            r.starts_at + v_shift, r.ends_at + v_shift,
            r.capacity, r.counts_toward_badges,
            r.badge_award_mode, r.allow_student_scan, r.display_order, r.is_active)
    returning id into v_new_cp;
    v_cp_map := v_cp_map || jsonb_build_object(r.id::text, v_new_cp);
    v_cps := v_cps + 1;
  end loop;

  -- Re-point the wired checkpoints through the map. Early Bird cutoff stays
  -- NULL — it is a time of a specific morning, set when that morning is real.
  v_new_checkin := (v_cp_map ->> v_src.checkin_checkpoint_id::text)::integer;
  v_new_eb      := (v_cp_map ->> v_src.early_bird_checkpoint_id::text)::integer;
  update events
     set checkin_checkpoint_id = v_new_checkin,
         early_bird_checkpoint_id = v_new_eb,
         early_bird_until = null
   where id = v_new_id;

  for r in select * from gift_tiers where event_id = p_source_id order by tier loop
    insert into gift_tiers (event_id, tier, required_badges, gift_name,
                            stock_total, stock_issued, is_active)
    values (v_new_id, r.tier, r.required_badges, r.gift_name,
            r.stock_total, 0, r.is_active);
    v_tiers := v_tiers + 1;
  end loop;

  for r in select * from special_activities where event_id = p_source_id order by id loop
    insert into special_activities (event_id, name, capacity, is_open)
    values (v_new_id, r.name, r.capacity, false)
    returning id into v_new_act;
    perform ensure_special_slots(v_new_act);
    v_specials := v_specials + 1;
  end loop;

  insert into audit_log (event_id, actor_type, actor_id, action, target_type, target_id,
                         after_state)
  values (v_new_id, 'super_admin', trim(p_actor), 'clone_event', 'event',
          p_source_id::text,
          jsonb_build_object('new_event_id', v_new_id, 'slug', p_slug,
                             'zones', v_zones, 'checkpoints', v_cps,
                             'tiers', v_tiers, 'specials', v_specials));

  return query select v_new_id, v_zones, v_cps, v_tiers, v_specials;
end;
$$;
