# @atl/qr-token

Quy ước: sửa package này thì thêm một dòng vào đây trong CÙNG commit.
Mốc ổn định của cả engine là git tag `engine-vX.Y.Z` — xem docs/FORK-PLAYBOOK.md.

## 1.0.0 — 2026-08-26 (engine-v1.0.0)
- Token QR ký HMAC 16 byte, verify offline hai đầu, Base32 canonical (chặn mutation), mã tra cứu 6 ký tự Crockford. 26 test.
