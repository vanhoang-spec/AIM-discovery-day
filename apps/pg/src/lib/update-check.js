'use client';

/**
 * Tự phát hiện bản mới: lần hỏi ĐẦU TIÊN sau khi trang nạp là "bản của tôi",
 * các lần sau lệch đi nghĩa là server đã deploy. Reload là đủ để lên bản mới —
 * phiên, PIN, hàng đợi, danh sách SV đều ở IndexedDB nên không mất gì.
 *
 * Poll 5 phút một lần, chỉ khi online và tab đang hiện — 45 máy × 12 lần/giờ
 * là 540 request/giờ, không đáng kể. Lỗi mạng thì bỏ qua, thử lại lượt sau:
 * nút Cập nhật là tiện nghi, không bao giờ được làm phiền việc quét.
 */

import { useEffect, useState } from 'react';

const EVERY_MS = 5 * 60 * 1000;

export function useUpdateAvailable() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let baseline = null;
    let stop = false;
    const check = async () => {
      if (stop || !navigator.onLine || document.visibilityState === 'hidden') return;
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        const { build } = await r.json();
        if (!build || build === 'dev') return;
        if (baseline === null) baseline = build;
        else if (build !== baseline) setAvailable(true);
      } catch { /* lượt sau thử lại */ }
    };
    check();
    const iv = setInterval(check, EVERY_MS);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  return available;
}
