import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import Providers from "@/components/Providers";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Internship Nest — find internships you can actually get to",
  description:
    "Internship Nest ranks startups by how far they actually are from you, then by everything else.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={instrumentSans.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
