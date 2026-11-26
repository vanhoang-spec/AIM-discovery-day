/**
 * Import file này TRƯỚC khi `await import()` một route của apps/web. Route phải
 * được import động (sau dòng register), vì import tĩnh được resolve trước khi
 * hook kịp đăng ký.
 */
import { register } from 'node:module';

register('./next-alias-hooks.mjs', import.meta.url);
