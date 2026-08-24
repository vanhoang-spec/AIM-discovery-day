import './globals.css';
import { IBM_Plex_Sans } from 'next/font/google';

// The `vietnamese` subset is the point: a face without it renders "Nguyễn" with
// misplaced tone marks. Self-hosted by next/font — no runtime Google request,
// which matters on a congested courtyard connection.
const plex = IBM_Plex_Sans({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '600', '700'],
  display: 'swap',
});

export const metadata = {
  title: 'Awaken The Lions 2026 — Discovery Day',
  description:
    'Đăng ký tham gia Discovery Day 12/09/2026 tại FTU Hà Nội và TP.HCM — nhận mã QR, thu thập badge, đổi quà.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f5f0' },
    { media: '(prefers-color-scheme: dark)', color: '#14171c' },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi" className={plex.className}>
      <body>{children}</body>
    </html>
  );
}
