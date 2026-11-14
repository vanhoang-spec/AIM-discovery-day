import Link from 'next/link';

export default function Home() {
  return (
    <main className="wrap">
      <h1>Discovery Day</h1>
      <p className="sub">
        Ngày hội khám phá, học hỏi và trải nghiệm dành cho sinh viên · miễn phí.
        Xem ngày giờ và địa điểm ở trang đăng ký.
      </p>
      <Link href="/dang-ky">
        <button className="primary" type="button">ĐĂNG KÝ THAM GIA</button>
      </Link>
      <Link href="/toi">
        <button className="ghost" type="button">Mã QR của mình</button>
      </Link>
    </main>
  );
}
