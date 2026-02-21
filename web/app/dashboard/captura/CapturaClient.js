"use client";

import { useEffect, useMemo, useState } from "react";

const initialContext = { methods: [], hasTrip: false, activeTripId: null };

export default function CapturaClient() {
  const [context, setContext] = useState(initialContext);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState(null);
  const [selectedMethod, setSelectedMethod] = useState("");
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/expense-capture-context", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setContext(data));
  }, []);

  const hasMethods = useMemo(() => (context.methods || []).length > 0, [context.methods]);

  async function onDraft(e) {
    e.preventDefault();
    const res = await fetch("/api/expense-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    setDraft(data?.draft || null);
    setStatus("draft");
    setMessage("");
  }

  async function onConfirm() {
    if (!draft || !selectedMethod) return;
    const res = await fetch("/api/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft, methodId: selectedMethod })
    });
    if (res.ok) {
      setMessage("guardado");
      setText("");
      setDraft(null);
      setSelectedMethod("");
      setStatus("idle");
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">Captura de gasto</h1>
      <form className="mt-4 flex gap-2" onSubmit={onDraft}>
        <input
          aria-label="captura-input"
          className="flex-1 rounded border border-slate-300 px-3 py-2"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ej: 100 uber"
        />
        <button className="rounded bg-slate-900 px-4 py-2 text-white" type="submit">
          Enviar
        </button>
      </form>

      {context.hasTrip ? (
        <div className="mt-4 flex gap-2">
          <button type="button">Es del viaje</button>
          <button type="button">No es del viaje</button>
        </div>
      ) : null}

      {draft ? (
        <section className="mt-4">
          <p>
            Draft: {draft.amount} - {draft.description}
          </p>
          {hasMethods ? (
            <div className="mt-2 flex gap-2">
              {context.methods.map((method) => (
                <button key={method.id} type="button" onClick={() => setSelectedMethod(method.id)}>
                  {method.label}
                </button>
              ))}
            </div>
          ) : (
            <p>No encontramos métodos</p>
          )}

          {!hasMethods ? <p>Sin métodos</p> : null}

          <button className="mt-3 rounded bg-emerald-700 px-4 py-2 text-white" onClick={onConfirm}>
            Confirmar
          </button>
        </section>
      ) : null}

      {status === "idle" && message ? <p className="mt-4">{message}</p> : null}
    </main>
  );
}
