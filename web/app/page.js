import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Corte Dashboard</h1>
      <p className="mt-2 text-slate-600">
        Abre el dashboard con tu token y chat_id para ver el cashflow mensual.
      </p>
      <Link
        className="mt-4 inline-flex rounded bg-slate-900 px-4 py-2 text-white"
        href="/dashboard"
      >
        Ir a /dashboard
      </Link>
    </main>
  );
}
