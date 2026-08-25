import { AgendaView } from '../agenda.js';

export const revalidate = 60;
export const metadata = { title: 'Lịch theo khu vực — Awaken The Lions 2026' };

export default function AgendaByZone() {
  return <AgendaView view="zone" />;
}
