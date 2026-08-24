import Link from 'next/link';

export default function Home() {
  return (
    <main className="wrap">
      <h1>Awaken The Lions 2026 — Discovery Day</h1>
      <p className="sub">
        Ngày hội khám phá, học hỏi và trải nghiệm dành cho sinh viên.
        Thứ Bảy 12/09/2026 · 8h–17h · FTU Hà Nội &amp; TP.HCM · miễn phí.
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
