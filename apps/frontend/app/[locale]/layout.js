import "../globals.css";
import LocaleSwitcher from "../locale-switcher.jsx";

export const metadata = {
  title: "Elder Labor Assistant",
  description: "Accessible RAG demo for elders",
};

const SUPPORTED = ["zh", "en"];

export default async function RootLayout({ children, params }) {
  const { locale } = await params;
  const safe = SUPPORTED.includes(locale) ? locale : "zh";

  return (
    <html lang={safe === "zh" ? "zh-Hant" : "en"}>
      <body className="min-h-screen bg-gradient-to-br from-sky-50 via-emerald-50 to-slate-100 text-slate-900">
        {/* top bar */}
        <header className="w-full">
          <div className="mx-auto max-w-6xl px-4 md:px-8 py-3 flex justify-end">
            <LocaleSwitcher locale={safe} />
          </div>
        </header>

        {/* wider main */}
        <main className="mx-auto max-w-6xl px-4 md:px-8 pb-36 pt-2">
          {children}
        </main>
      </body>
    </html>
  );
}
