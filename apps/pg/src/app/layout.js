import './globals.css';
import { BRAND } from '@atl/brand';

export const metadata = {
  title: BRAND.scannerTitle,
  description: 'Ứng dụng quét badge cho PG. Hoạt động cả khi không có mạng.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,   // stops a mis-tap zooming the camera view mid-queue
  themeColor: '#14171c',
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
