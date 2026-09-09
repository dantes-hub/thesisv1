import type { Metadata, Viewport } from "next";
import "../globals.css";
import zh from "../../messages/zh.json";
import en from "../../messages/en.json";

const SUPPORTED = ["zh", "en"] as const;
type Locale = (typeof SUPPORTED)[number];

function resolve(locale: string): Locale {
  return (SUPPORTED as readonly string[]).includes(locale) ? (locale as Locale) : "zh";
}

// Rendered on the server so the title and lang attribute are correct in the
// initial HTML, which is what assistive technology reads.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const copy = resolve(locale) === "zh" ? zh : en;
  return { title: copy.title, description: copy.desc };
}

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f4f8fb",
  // Older users rely on browser zoom; never disable it.
  userScalable: true,
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const safe = resolve(locale);
  return (
    <html lang={safe === "zh" ? "zh-Hant" : "en"}>
      <body>{children}</body>
    </html>
  );
}
