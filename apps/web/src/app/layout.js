import './globals.css';
import { Roboto, Roboto_Slab } from 'next/font/google';
import { BRAND } from '@atl/brand';

// The `vietnamese` subset is the point: a face without it renders "Nguyễn" with
// misplaced tone marks. Self-hosted by next/font — no runtime Google request,
// which matters on a congested courtyard connection. Roboto/Roboto Slab are the
// event site's own faces (Elementor kit), both with full Vietnamese coverage.
const roboto = Roboto({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '700'],
  display: 'swap',
});
const robotoSlab = Roboto_Slab({
  subsets: ['latin', 'vietnamese'],
  weight: ['600', '700'],
  display: 'swap',
  variable: '--font-display',
});

export const metadata = {
  title: BRAND.eventTitle,
  description:
    'Đăng ký tham gia Discovery Day 12/09/2026 tại FTU Hà Nội và TP.HCM — nhận mã QR, thu thập badge, đổi quà.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f5f2' },
    { media: '(prefers-color-scheme: dark)', color: '#0f0d0c' },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi" className={`${roboto.className} ${robotoSlab.variable}`}>
      <body>{children}</body>
    </html>
  );
}
