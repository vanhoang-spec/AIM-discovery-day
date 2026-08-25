import { AgendaView } from './agenda.js';

export const revalidate = 60;
export const metadata = { title: 'Lịch hoạt động — Awaken The Lions 2026' };

export default function AgendaByTime() {
  return <AgendaView view="time" />;
}
