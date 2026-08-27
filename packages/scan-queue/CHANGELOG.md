# @atl/scan-queue

Quy ước: sửa package này thì thêm một dòng vào đây trong CÙNG commit.
Mốc ổn định của cả engine là git tag `engine-vX.Y.Z` — xem docs/FORK-PLAYBOOK.md.

## 1.0.0 — 2026-08-26 (engine-v1.0.0)
- Hàng đợi quét offline: idempotency hai lớp, backoff jitter, không phản hồi = giữ lại chờ gửi. Kèm environment detect webview. 43 test.
