import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', 'migrations');

let db;

async function freshDb() {
  const pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  await pg.exec(`
    insert into editions (id, year, name) values (1, 2026, 'ATL 2026');
    insert into events (id, edition_id, kind, slug, name, venue_name, city, starts_at, ends_at,
                        token_key_id, gift_ladder_mode, special_threshold_y, special_claim_limit)
    values (1, 1, 'discovery_day', 'hn', 'DD HN', 'FTU HN', 'HN',
            '2026-09-12 08:00+07', '2026-09-12 17:00+07', 'k1', 'cumulative', 5, 2);

    insert into gift_tiers (id, event_id, tier, required_badges, gift_name, stock_total) values
      (1, 1, 1, 1, 'Bút chì', 1000),
      (2, 1, 2, 2, 'Sổ tay',  500),
      (3, 1, 3, 3, 'Túi vải', 3);

    insert into special_activities (id, event_id, name, capacity) values
      (1, 1, 'Quay số trúng thưởng', 5),
      (2, 1, 'Giao lưu khách mời',   3);
  `);
  await pg.query(`select ensure_special_slots(1)`);
  await pg.query(`select ensure_special_slots(2)`);
  return pg;
}

/** Create a student with `badges` badge_count already set. Both ladders are
 *  set to the same value — the common case of badges earned at booths; tests
 *  that need the ladders to diverge (0007) set core_badge_count themselves. */
async function student(pg, seq, badges = 0) {
  const r = await pg.query(
    `insert into students (seq, lookup_code, full_name, name_search_key, email)
     values ($1, $2, $3, $4, $5) returning id`,
    [seq, `S${String(seq).padStart(5, '0')}`.slice(0, 6), `SV ${seq}`, `sv ${seq}`, `s${seq}@t.vn`],
  );
  const id = r.rows[0].id;
  await pg.query(
    `insert into registrations (student_id, event_id, badge_count, core_badge_count)
     values ($1, 1, $2, $2)`,
    [id, badges],
  );
  return id;
}

const claimGift = (pg, sid, tier) =>
  pg.query(`select * from claim_gift_tier(1::smallint, $1, $2, 'staff-1', 'dev-1')`, [sid, tier])
    .then((r) => r.rows[0]);

const hold = (pg, sid, act, secs = 90) =>
  pg.query(`select * from hold_special_slot(1::smallint, $1, $2, $3)`, [sid, act, secs])
    .then((r) => r.rows[0]);

const confirm = (pg, sid, act) =>
  pg.query(`select * from confirm_special_slot(1::smallint, $1, $2, 'staff-1')`, [sid, act])
    .then((r) => r.rows[0]);

beforeEach(async () => {
  db = await freshDb();
});

describe('gift ladder', () => {
  // [0014] Bất biến rẻ nhất của cả hệ quà: kho đã trừ phải đúng bằng số dòng đã
  // ghi, từng bậc một. Mọi đường rò đều lộ ra ở đây — kể cả đường trừ-rồi-hoàn
  // khi hai máy tranh nhau, thứ mà không assert nào trong bài nhìn thấy.
  afterEach(async () => {
    const drift = await db.query(
      `select gt.id from gift_tiers gt
        where gt.stock_issued <> (select count(*) from gift_redemptions gr
                                   where gr.gift_tier_id = gt.id)`);
    assert.deepEqual(drift.rows, [], 'stock_issued phải bằng số dòng đổi quà của bậc đó');
  });

  test('a student below the threshold is refused', async () => {
    const s = await student(db, 2001, 0);
    const r = await claimGift(db, s, 1);
    assert.equal(r.result, 'not_eligible');

    const stock = await db.query(`select stock_issued from gift_tiers where id = 1`);
    assert.equal(stock.rows[0].stock_issued, 0, 'a refused claim must not consume stock');
  });

  test('claiming the same tier twice yields one gift and one unit of stock', async () => {
    // Đúng 1 badge: bậc 1 là bậc cao nhất em này với tới, nên không vướng luật
    // chặn phát lùi của 0014. Bài này canh chuyện khác — bấm lại phải an toàn.
    const s = await student(db, 2002, 1);

    const first = await claimGift(db, s, 1);
    assert.equal(first.result, 'ok');
    assert.equal(first.gift_name, 'Bút chì');

    // The counter's connection dropped; the staff member taps again.
    for (let i = 0; i < 10; i++) {
      assert.equal((await claimGift(db, s, 1)).result, 'already_claimed');
    }

    const stock = await db.query(`select stock_issued from gift_tiers where id = 1`);
    assert.equal(stock.rows[0].stock_issued, 1, 'retries must not burn stock');

    const rows = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1 and gift_tier_id = 1`,
      [s]);
    assert.equal(rows.rows[0].c, 1);
  });

  test('bậc cao nhất cấp kèm mọi bậc thấp — một lượt, một lần trừ kho mỗi bậc', async () => {
    const s = await student(db, 2003, 3);

    // [0014] Bấm bậc thấp trong khi bậc cao còn trên bàn là một cú bấm nhầm:
    // ở ATL nó nghĩa là đưa chiếc túi ra rồi lát nữa đưa thêm một chiếc nữa.
    assert.equal((await claimGift(db, s, 1)).result, 'claim_top_tier_first');
    assert.equal((await claimGift(db, s, 2)).result, 'claim_top_tier_first');

    assert.equal((await claimGift(db, s, 3)).result, 'ok');

    const n = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1`, [s]);
    assert.equal(n.rows[0].c, 3, 'một lượt phát ghi đủ ba dòng');

    const st = await db.query(
      `select stock_issued from gift_tiers where event_id = 1 order by tier`);
    assert.deepEqual(st.rows.map((r) => r.stock_issued), [1, 1, 1],
      'đúng một đơn vị mỗi món rời bàn — không hơn, không kém');

    // Bấm lại bậc nào cũng phải là câu trả lời của người, không phải mã lỗi.
    assert.equal((await claimGift(db, s, 3)).result, 'already_claimed');
    assert.equal((await claimGift(db, s, 1)).result, 'already_claimed');
  });

  test('highest_only mode hands over exactly one gift, and it must be the best one', async () => {
    await db.query(`update events set gift_ladder_mode = 'highest_only' where id = 1`);
    const s = await student(db, 2004, 3);

    // Asking for a lower tier is a counter mistake, not a choice.
    assert.equal((await claimGift(db, s, 1)).result, 'not_highest_tier');
    assert.equal((await claimGift(db, s, 3)).result, 'ok');
    assert.equal((await claimGift(db, s, 2)).result, 'already_claimed');

    const n = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1`, [s]);
    assert.equal(n.rows[0].c, 1);
  });

  test('stock runs out exactly at the limit, never past it', async () => {
    // Tier 3 has 3 units.
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await student(db, 2100 + i, 5));

    const results = [];
    for (const id of ids) results.push((await claimGift(db, id, 3)).result);

    assert.equal(results.filter((r) => r === 'ok').length, 3, 'exactly the stock, no more');
    assert.equal(results.filter((r) => r === 'out_of_stock').length, 7);

    const stock = await db.query(`select stock_issued, stock_total from gift_tiers where id = 3`);
    assert.equal(stock.rows[0].stock_issued, 3);
    assert.ok(stock.rows[0].stock_issued <= stock.rows[0].stock_total);

    // [0014] Ba lượt thành công ấy cũng ăn ba đơn vị của hai bậc dưới — bảy
    // lượt hết kho thì không, vì chúng dừng trước khi tới đoạn cấp kèm.
    const lower = await db.query(
      `select stock_issued from gift_tiers where id in (1, 2) order by tier`);
    assert.deepEqual(lower.rows.map((r) => r.stock_issued), [3, 3]);
  });

  test('the database itself refuses to oversell, even by hand', async () => {
    await assert.rejects(
      () => db.query(`update gift_tiers set stock_issued = stock_total + 1 where id = 3`),
      /violates check/i,
      'the check constraint is the backstop behind the function',
    );
  });

  test('raising the threshold does not revoke a gift already handed over', async () => {
    const s = await student(db, 2200, 2);
    assert.equal((await claimGift(db, s, 2)).result, 'ok');

    const grant = await db.query(
      `select threshold_at_grant, badge_count_at_grant from gift_redemptions
        where student_id = $1 and gift_tier_id = 2`, [s]);
    assert.equal(grant.rows[0].threshold_at_grant, 2, 'the rule at grant time is recorded');
    assert.equal(grant.rows[0].badge_count_at_grant, 2);

    // Admin raises x mid-event. The student keeps the notebook.
    await db.query(`update gift_tiers set required_badges = 4 where id = 2`);
    const still = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1`, [s]);
    // Hai dòng: bậc 2 em bấm, và bậc 1 được cấp kèm theo 0014. Cả hai đều
    // không bị đụng tới khi ngưỡng tăng.
    assert.equal(still.rows[0].c, 2);

    // But they cannot now claim a tier they no longer qualify for.
    const s2 = await student(db, 2201, 2);
    assert.equal((await claimGift(db, s2, 2)).result, 'not_eligible');
  });

  // --------------------------------------------------------------------------
  // Quy định của AIM, 10/09 — nói bằng đúng lời của cái bàn quà.
  //
  // Fixture ba bậc ở trên là bài toán tổng quát. Cấu hình thật ngày 12/09 chỉ có
  // hai bậc và hai vật thể: một chồng TÚI, một thùng HỘP BÚT.
  // --------------------------------------------------------------------------

  const aimTiers = () => db.exec(`
    update gift_tiers set is_active = false where id = 3;
    update gift_tiers set required_badges = 7, gift_name = 'Túi quà',
                          stock_total = 5 where id = 1;
    update gift_tiers set required_badges = 9, gift_name = 'Hộp bút Thiên Long',
                          stock_total = 5 where id = 2;
  `);

  test('7 badge nhận túi; đủ 9 quay lại chỉ nhận THÊM hộp bút', async () => {
    await aimTiers();
    const s = await student(db, 2300, 7);

    assert.equal((await claimGift(db, s, 1)).result, 'ok');
    assert.equal((await claimGift(db, s, 2)).result, 'not_eligible');

    await db.query(`update registrations set badge_count = 9 where student_id = $1`, [s]);
    assert.equal((await claimGift(db, s, 2)).result, 'ok');

    const st = await db.query(
      `select stock_issued from gift_tiers where id in (1, 2) order by tier`);
    assert.deepEqual(st.rows.map((r) => r.stock_issued), [1, 1],
      'PG không đổi lại túi: đúng một túi và một hộp bút rời bàn');
  });

  test('đủ 9 badge ngay từ đầu: một lượt phát, cả túi lẫn hộp bút', async () => {
    await aimTiers();
    const s = await student(db, 2301, 9);

    assert.equal((await claimGift(db, s, 1)).result, 'claim_top_tier_first',
      'không làm giao dịch mức 7 riêng — mức 9 đã gồm chiếc túi');
    assert.equal((await claimGift(db, s, 2)).result, 'ok');

    const rows = await db.query(
      `select gift_tier_id from gift_redemptions
        where student_id = $1 order by gift_tier_id`, [s]);
    assert.deepEqual(rows.rows.map((r) => r.gift_tier_id), [1, 2],
      'một cú bấm, hai dòng — sổ sách khớp với hai món trên tay SV');
  });

  test('hết túi vẫn trao được hộp bút, và ngược lại', async () => {
    await aimTiers();
    await db.query(`update gift_tiers set stock_total = 0 where id = 1`);

    const a = await student(db, 2302, 9);
    assert.equal((await claimGift(db, a, 2)).result, 'ok', 'hết túi không được chặn hộp bút');
    const owed = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1`, [a]);
    assert.equal(owed.rows[0].c, 1, 'chỉ ghi hộp bút — em này đang bị nợ một chiếc túi');

    // BTC nạp thêm túi giữa ngày: em quay lại lấy được ngay, luật chặn phát lùi
    // đã im vì bậc 9 đã nhận.
    await db.query(`update gift_tiers set stock_total = 2 where id = 1`);
    assert.equal((await claimGift(db, a, 1)).result, 'ok');

    // Chiều ngược lại: hết hộp bút thì SV 9 badge vẫn phải nhận được túi.
    await db.query(`update gift_tiers set stock_total = stock_issued where id = 2`);
    const b = await student(db, 2303, 9);
    assert.equal((await claimGift(db, b, 2)).result, 'out_of_stock');
    assert.equal((await claimGift(db, b, 1)).result, 'ok');
  });

  test('vé giấy đi thẳng: không cấp kèm, không bị chặn phát lùi', async () => {
    await aimTiers();
    const s = await student(db, 2304, 9);

    // Sổ giấy ghi hai tấm vé riêng. Giám sát viên nhập vé mức 9 trước — thứ tự
    // người ta hay làm — rồi tới vé mức 7. Cả hai đều phải vào được, nếu không
    // một cuốn sổ đúng bị màn Đối soát báo là "vé giấy trùng".
    const paper = (tier) => db.query(
      `select * from claim_gift_tier(1::smallint, $1, $2, 'paper:admin', 'reconciliation', true)`,
      [s, tier]).then((r) => r.rows[0]);

    assert.equal((await paper(2)).result, 'ok');
    const after = await db.query(
      `select count(*)::int as c from gift_redemptions where student_id = $1`, [s]);
    assert.equal(after.rows[0].c, 1, 'vé giấy chỉ ghi đúng món ghi trên tấm vé');

    assert.equal((await paper(1)).result, 'ok', 'tấm vé thật không bị báo là vé trùng');
  });
});

describe('capacity-limited special activities', () => {
  test('slots are pre-created to match capacity', async () => {
    const r = await db.query(
      `select count(*)::int as c from special_slots where special_activity_id = 1`);
    assert.equal(r.rows[0].c, 5);
  });

  test('a student below the y threshold cannot hold a slot', async () => {
    const s = await student(db, 3001, 4); // y = 5
    assert.equal((await hold(db, s, 1)).result, 'not_eligible');
  });

  test('exactly `capacity` students get a slot — never one more', async () => {
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(await student(db, 3100 + i, 5));

    let held = 0;
    let soldOut = 0;
    for (const id of ids) {
      const r = await hold(db, id, 1);
      if (r.result === 'held') {
        held++;
        assert.equal((await confirm(db, id, 1)).result, 'ok');
      } else if (r.result === 'sold_out') {
        soldOut++;
      }
    }

    assert.equal(held, 5, 'capacity is 5, so exactly 5 students may be promised a seat');
    assert.equal(soldOut, 15);

    const claimed = await db.query(
      `select count(*)::int as c from special_slots
        where special_activity_id = 1 and student_id is not null`);
    assert.equal(claimed.rows[0].c, 5);
  });

  test('slot numbers are unique and contiguous, so a paper list matches the app', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await student(db, 3200 + i, 5));
    const nums = [];
    for (const id of ids) {
      await hold(db, id, 1);
      nums.push((await confirm(db, id, 1)).slot_no);
    }
    assert.deepEqual([...nums].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  test('z caps how many special activities one student may take', async () => {
    await db.query(`update events set special_claim_limit = 1 where id = 1`);
    const s = await student(db, 3300, 5);

    assert.equal((await hold(db, s, 1)).result, 'held');
    assert.equal((await confirm(db, s, 1)).result, 'ok');
    assert.equal((await hold(db, s, 2)).result, 'limit_reached');
  });

  test('a second hold on the same activity returns the existing one', async () => {
    const s = await student(db, 3400, 5);
    const a = await hold(db, s, 1);
    assert.equal(a.result, 'held');
    const b = await hold(db, s, 1);
    assert.equal(b.result, 'already_held');
    assert.equal(b.slot_no, a.slot_no, 'the student keeps the slot they were shown');
  });

  test('an expired hold releases the slot back to the pool', async () => {
    const a = await student(db, 3500, 5);
    const held = await hold(db, a, 2, 0); // expires immediately
    assert.equal(held.result, 'held');

    // The connection dropped before the student was told. The seat must not be
    // burned forever.
    const b = await student(db, 3501, 5);
    const reclaimed = await hold(db, b, 2);
    assert.equal(reclaimed.result, 'held');
    assert.equal(reclaimed.slot_no, held.slot_no, 'the same seat is reissued');

    // And the original holder can no longer confirm it.
    assert.equal((await confirm(db, a, 2)).result, 'hold_expired');
  });

  test('confirming twice is safe — a retried request is not an error', async () => {
    const s = await student(db, 3600, 5);
    await hold(db, s, 1);
    const first = await confirm(db, s, 1);
    assert.equal(first.result, 'ok');

    for (let i = 0; i < 5; i++) {
      const again = await confirm(db, s, 1);
      assert.equal(again.result, 'ok');
      assert.equal(again.slot_no, first.slot_no);
    }

    const n = await db.query(
      `select count(*)::int as c from special_slots
        where special_activity_id = 1 and student_id = $1`, [s]);
    assert.equal(n.rows[0].c, 1);
  });

  test('raising capacity adds seats without disturbing the ones already taken', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await student(db, 3700 + i, 5));
    for (const id of ids) {
      await hold(db, id, 1);
      await confirm(db, id, 1);
    }
    assert.equal((await hold(db, await student(db, 3799, 5), 1)).result, 'sold_out');

    await db.query(`update special_activities set capacity = 8 where id = 1`);
    await db.query(`select ensure_special_slots(1)`);

    const late = await student(db, 3800, 5);
    const r = await hold(db, late, 1);
    assert.equal(r.result, 'held');
    assert.equal(r.slot_no, 6);

    const taken = await db.query(
      `select count(*)::int as c from special_slots
        where special_activity_id = 1 and student_id is not null`);
    assert.equal(taken.rows[0].c, 5, 'existing claims are untouched');
  });

  test('lowering capacity removes only free seats', async () => {
    const s = await student(db, 3900, 5);
    await hold(db, s, 1);
    await confirm(db, s, 1);

    await db.query(`update special_activities set capacity = 2 where id = 1`);
    await db.query(`select ensure_special_slots(1)`);

    const rows = await db.query(
      `select count(*)::int as c from special_slots where special_activity_id = 1`);
    assert.equal(rows.rows[0].c, 2);

    const kept = await db.query(
      `select count(*)::int as c from special_slots
        where special_activity_id = 1 and student_id = $1`, [s]);
    assert.equal(kept.rows[0].c, 1, 'a claimed seat is never deleted');
  });

  test('the control panel reports what the admin needs to close the gate', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await student(db, 4000 + i, 5);
      await hold(db, id, 1);
      await confirm(db, id, 1);
    }
    await hold(db, await student(db, 4100, 5), 1); // held, not confirmed
    await student(db, 4200, 6); // eligible, has not claimed

    const r = await db.query(
      `select * from v_special_control_panel where special_activity_id = 1`);
    const row = r.rows[0];
    assert.equal(row.capacity, 5);
    assert.equal(row.claimed, 3);
    assert.equal(row.on_hold, 1);
    assert.equal(row.available, 1);
    assert.ok(row.students_eligible >= 5);
  });
});
