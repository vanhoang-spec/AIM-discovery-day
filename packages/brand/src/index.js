/**
 * @atl/brand — the ONE place a fork changes to rebrand the whole system.
 *
 * Fork playbook, step "đổi brand": edit this file + the BRAND KIT block at
 * the top of each app's globals.css. Nothing else in the codebase names a
 * client, an event, or a colour.
 *
 * Palette source: the live event site (awakenthelions.net Elementor kit) —
 * black ground, white text, rose-gold accent #CAA79D, Roboto Slab display.
 * The raw brand accent only passes contrast on DARK grounds; on light
 * grounds every consumer must use ACCENT_ON_LIGHT (same hue, darkened to
 * 6.2:1 against the light paper — AA for normal text).
 */

export const BRAND = {
  // Names
  campaign: 'Awaken The Lions 2026',
  eventTitle: 'Awaken The Lions 2026 — Discovery Day',
  scannerTitle: 'ATL2026 — Máy quét PG',
  shortCode: 'ATL2026',

  // Colours
  accent: '#CAA79D',          // rose-gold — dark grounds only
  accentOnLight: '#864C3C',   // same hue, AA on light paper
  accentSoftLight: '#F0E2DA', // tint for callout backgrounds on light
  darkGround: '#0F0D0C',      // app dark theme paper (site is #000; lifted for layering)
  lightGround: '#F8F5F2',     // app light theme paper

  // Email (light-only — dark email renders badly across clients)
  email: {
    // Where a student's "Reply" actually lands. The From address is a
    // no-reply on the sending subdomain, and that subdomain has NO MX record
    // by design — so without this, every reply bounces into nothing. With
    // ~4.000 confirmations going out, some students WILL just hit reply.
    // A different domain here is fine: SPF/DKIM/DMARC only ever check From.
    replyTo: 'competition@aimacademy.vn',
    eyebrow: '#864C3C',
    calloutBg: '#F0E2DA',
    calloutBorder: '#864C3C',
    calloutText: '#5B3428',
    ground: '#F5F1EE',
    cardBorder: '#E3D8D1',
  },
};
