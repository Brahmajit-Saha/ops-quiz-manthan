import './globals.css';
import { Chakra_Petch, JetBrains_Mono, Inter } from 'next/font/google';
import Header from './components/Header';

// §4 typography: Chakra Petch (display), JetBrains Mono (numbers), Inter (body).
const display = Chakra_Petch({ subsets: ['latin'], weight: ['500','600','700'], variable: '--font-display' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['500','700'], variable: '--font-mono' });
const body = Inter({ subsets: ['latin'], weight: ['400','500','600'], variable: '--font-body' });

export const metadata = {
  title: 'OPS in One Word — OPSPHERE',
  description: 'Manthan Round 2 buzzer game · OPSPHERE, Operations Club, IBS Bengaluru',
};
export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1 };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable} ${body.variable}`}>
      <body>
        <Header />
        <div id="app">{children}</div>
        {/* §6 — permanent developer credit, must remain visible in every deployment */}
        <footer className="opscredit">Built by Brahmajit Saha · OPSPHERE, Operations Club, IBS Bengaluru</footer>
      </body>
    </html>
  );
}
