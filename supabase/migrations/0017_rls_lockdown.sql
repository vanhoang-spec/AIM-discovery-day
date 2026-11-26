-- ---------------------------------------------------------------------------
-- 0017 — Khoá schema public trước REST API của Supabase (vá bảo mật 26/11/2026)
--
-- Supabase tự mở mọi bảng / function trong schema public qua PostgREST
-- (/rest/v1, /rest/v1/rpc) cho role `anon` và `authenticated`: default
-- privileges của project cấp sẵn quyền cho hai role đó trên mọi object mới.
-- Trước file này database CHƯA bật RLS ở bảng nào — ai có khoá anon của project
-- là đọc / sửa thẳng được bảng students, attendance… mà không qua app.
--
-- App KHÔNG dùng supabase-js. Nó nối thẳng Postgres qua DATABASE_URL bằng role
-- chủ bảng (postgres, role chạy production-init.sql), nên:
--
--   * BẬT RLS trên MỌI bảng trong public, KHÔNG viết policy nào: anon /
--     authenticated không thấy dòng nào. KHÔNG dùng FORCE ROW LEVEL SECURITY —
--     chủ bảng vẫn bỏ qua RLS, đó là lý do app chạy tiếp y như cũ.
--   * THU mọi quyền của anon và authenticated trên bảng (gồm view), sequence,
--     function / procedure trong public.
--   * THU quyền EXECUTE mặc định của PUBLIC trên function của app. anon là
--     thành viên PUBLIC, và phần lớn function ở đây là SECURITY DEFINER (chạy
--     bằng quyền chủ, bỏ qua RLS): chỉ thu quyền riêng của anon mà để PUBLIC thì
--     anon vẫn gọi được /rest/v1/rpc/register_student. Chủ function (app) không
--     mất gì — chủ luôn giữ quyền của mình.
--   * DEFAULT PRIVILEGES: bảng / sequence / function do role chạy file này tạo
--     về sau không tự cấp cho anon / authenticated, function mới không tự cấp
--     EXECUTE cho PUBLIC. (Chỉ áp cho object do CHÍNH role này tạo — production
--     là postgres, cũng là role chạy mọi migration.)
--   * RLS thì không có "default": bảng MỚI ở migration sau phải tự
--     `alter table … enable row level security` trong cùng file — test
--     supabase/test/rls.test.js fail nếu quên.
--
-- Role anon / authenticated chỉ có trên Supabase: bọc trong DO kiểm role tồn
-- tại, nên PGlite (test, dev) chạy được file này. Object thuộc extension bỏ qua
-- (extension tự quản quyền của nó).
--
-- Chỉ THÊM: không DROP, không đổi kiểu, không đụng dữ liệu. Chạy lại lần hai an
-- toàn (enable / revoke lặp lại không sao).
-- ---------------------------------------------------------------------------

-- 1. RLS trên mọi bảng (thường + partitioned) của public.
do $$
#variable_conflict use_column
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
      from pg_class c
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p')
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
  loop
    execute format('alter table %s enable row level security', r.tbl);
  end loop;
end $$;

-- 2. Thu quyền của anon / authenticated + default privileges cho object mới.
do $$
#variable_conflict use_column
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on all tables in schema public from %I', v_role);
      execute format('revoke all on all sequences in schema public from %I', v_role);
      execute format('revoke all on all routines in schema public from %I', v_role);
      execute format('alter default privileges in schema public revoke all on tables from %I', v_role);
      execute format('alter default privileges in schema public revoke all on sequences from %I', v_role);
      execute format('alter default privileges in schema public revoke all on functions from %I', v_role);
    end if;
  end loop;
end $$;

-- 3. Thu EXECUTE của PUBLIC trên function / procedure của app (không phải của
--    extension). Chỉ function mà role đang chạy là chủ (hoặc thành viên role chủ).
do $$
#variable_conflict use_column
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and pg_has_role(p.proowner, 'MEMBER')
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on routine %s from public', r.fn);
  end loop;
end $$;

-- Function mới do role này tạo về sau: không tự cấp EXECUTE cho PUBLIC.
-- (Quyền mặc định này của Postgres là toàn cục, không thu được theo schema.)
alter default privileges revoke execute on functions from public;
