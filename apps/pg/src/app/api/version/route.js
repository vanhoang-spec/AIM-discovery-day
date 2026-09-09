/**
 * GET /api/version — mã bản dựng đang chạy trên server.
 *
 * Sinh ra từ câu hỏi của anh Hoàng tối 09/09 khi diễn tập: "mỗi lần deploy
 * phải cài lại máy PG hay sao?" — không: app là web, dữ liệu máy nằm trong
 * IndexedDB, chỉ cần TẢI LẠI TRANG. Endpoint này cho trang đang mở tự biết
 * server đã đổi bản để hiện nút Cập nhật, thay vì bắt PG nghe truyền miệng.
 *
 * VERCEL_GIT_COMMIT_SHA do Vercel gắn sẵn lúc build — không cần env mới.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(
    { build: process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
