/**
 * Hook resolve cho node --test: `@/x` → apps/web/src/x(.js), đúng như alias
 * `@/*` trong jsconfig.json mà Next dùng. Nhờ vậy test gọi thẳng được route
 * handler thật (GET/POST) thay vì chép lại logic của nó.
 */
const SRC = new URL('../../src/', import.meta.url);

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    let rel = specifier.slice(2);
    if (!/\.[cm]?js$/.test(rel)) rel += '.js';
    return next(new URL(rel, SRC).href, context);
  }
  return next(specifier, context);
}
