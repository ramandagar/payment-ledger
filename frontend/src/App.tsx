import { useCallback, useState } from "react";
import "./App.css";
import { ToastProvider } from "./components/ui";
import { Overview } from "./components/Overview";
import { Accounts } from "./components/Accounts";
import { Invoices } from "./components/Invoices";
import { Journal } from "./components/Journal";

type Section = "overview" | "accounts" | "invoices" | "journal";

const NAV: { id: Section; label: string; hint: string }[] = [
  { id: "overview", label: "Overview", hint: "Snapshot" },
  { id: "accounts", label: "Accounts", hint: "Chart of accounts" },
  { id: "invoices", label: "Invoices", hint: "Bill & collect" },
  { id: "journal", label: "Journal", hint: "Double-entry log" },
];

function Shell() {
  const [section, setSection] = useState<Section>("overview");
  // Global version counter: any mutation bumps it, every section refetches on change.
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            ◆
          </div>
          <div className="brand-text">
            <strong>Ledger</strong>
            <span>Mini TMS · AP Module</span>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-item${section === n.id ? " active" : ""}`}
              onClick={() => setSection(n.id)}
            >
              <span className="nav-label">{n.label}</span>
              <span className="nav-hint">{n.hint}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="dot" /> API&nbsp;
          <a href={import.meta.env.VITE_API_URL ?? "http://localhost:4000"} target="_blank" rel="noreferrer">
            {import.meta.env.VITE_API_URL ?? "http://localhost:4000"}
          </a>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{NAV.find((n) => n.id === section)?.label}</h1>
          <div className="topbar-meta muted">Payment Ledger &amp; Invoice Service</div>
        </header>
        <div className="content">
          {section === "overview" && <Overview refreshKey={refreshKey} onMutate={bump} />}
          {section === "accounts" && <Accounts refreshKey={refreshKey} onMutate={bump} />}
          {section === "invoices" && <Invoices refreshKey={refreshKey} onMutate={bump} />}
          {section === "journal" && <Journal refreshKey={refreshKey} />}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
