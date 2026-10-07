"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Globe2,
  LayoutDashboard,
  LockKeyhole,
  Network,
  Play,
  Radio,
  RotateCcw,
  Send,
  ShieldCheck,
  Smartphone,
  Wallet,
  X,
} from "lucide-react";
import type { State } from "../lib/types";

const money = (paise: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
const time = (date: number) =>
  new Date(date).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export default function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sender, setSender] = useState("alice@demo");
  const [receiver, setReceiver] = useState("bob@demo");
  const [amount, setAmount] = useState("500");
  const [tab, setTab] = useState<"all" | "SETTLED" | "REJECTED">("all");
  const [selected, setSelected] = useState("alice");
  const [help, setHelp] = useState(false);
  const [section, setSection] = useState("Overview");
  useEffect(() => {
    if (!help) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setHelp(false);
      if (event.key === "Tab") {
        const buttons = document.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button',
        );
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [help]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/state", { cache: "no-store", signal });
      if (!response.ok) throw new Error("Could not connect to the simulator");
      setState(await response.json());
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError"))
        setError("Connection interrupted. Retrying automatically…");
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = setInterval(() => void refresh(controller.signal), 3000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [refresh]);
  async function act(action: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "send" ? { sender, receiver, amount } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setState(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  function navigate(name: string, id: string) {
    setSection(name);
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const transactions = state?.transactions ?? [];
  const settled = transactions.filter((t) => t.status === "SETTLED");
  const packets = new Set(
    state?.devices.flatMap((d) => d.packets.map((p) => p.id)) ?? [],
  ).size;
  const device = state?.devices.find((d) => d.id === selected);
  const visible = transactions.filter((t) => tab === "all" || t.status === tab);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="MeshPay home">
          <span className="brand-mark">
            <Network size={23} />
          </span>
          mesh<span>pay</span>
          <span className="brand-dot">.</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">M</span>
          <div>
            MeshPay Sandbox<small>Personal workspace</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav>
          {[
            { name: "Overview", icon: LayoutDashboard, id: "overview" },
            { name: "Mesh network", icon: Network, id: "mesh" },
            { name: "Transactions", icon: ArrowDownLeft, id: "transactions" },
            { name: "Accounts", icon: Wallet, id: "accounts" },
          ].map((item) => (
            <button
              key={item.name}
              className={section === item.name ? "nav-item active" : "nav-item"}
              onClick={() => navigate(item.name, item.id)}
            >
              <item.icon size={19} />
              {item.name}
              {item.name === "Mesh network" && (
                <span className="nav-count">5</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="mini-orbit">
            <Radio size={22} />
          </span>
          <h3>
            A little signal.
            <br />A lot of possibility.
          </h3>
          <p>Explore how payments travel when the internet doesn’t.</p>
          <button onClick={() => setHelp(true)}>
            How it works <ArrowUpRight size={15} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <span className="environment-dot" />
          Local demo environment
          <button aria-label="About this demo" onClick={() => setHelp(true)}>
            <CircleHelp size={17} />
          </button>
        </div>
        <div className="profile">
          <span className="avatar navy">MP</span>
          <div>
            Demo workspace<small>Developer sandbox</small>
          </div>
          <span className="version">v1.0</span>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{section}</strong>
          </div>
          <div className="topbar-right">
            <span className="sandbox-label">
              <span /> SANDBOX MODE
            </span>
            <button
              className="icon-button"
              aria-label="Help"
              onClick={() => setHelp(true)}
            >
              <CircleHelp size={19} />
            </button>
            <span className="avatar small navy">MP</span>
          </div>
        </header>
        <main id="overview">
          <div className="page-heading">
            <div>
              <div className="eyebrow">THE OFFLINE PAYMENT LAB</div>
              <h1>
                Payments beyond connectivity<span>.</span>
              </h1>
              <p>
                Watch encrypted payments find their way. One device at a time.
              </p>
            </div>
            <button
              className="button dark"
              disabled={busy || !state}
              onClick={() => void act("demo")}
            >
              <Play size={15} fill="currentColor" />
              {busy ? "Working…" : "Run live demo"}
              <ArrowUpRight size={16} />
            </button>
          </div>
          <div className="demo-banner">
            <span className="banner-icon">
              <Radio size={19} />
            </span>
            <div>
              <strong>Offline by design. Connected through people.</strong>
              <span>
                This sandbox simulates a Bluetooth mesh. Payments settle when a
                bridge reaches the internet.
              </span>
            </div>
            <span className="pill outline">Simulation</span>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          <section className="stats-grid" aria-label="Simulation statistics">
            <Stat
              label="NETWORK DEVICES"
              value={
                state ? String(state.devices.length).padStart(2, "0") : "—"
              }
              icon={<Smartphone size={19} />}
              detail="3 offline · 2 bridge nodes"
              tone="green"
            />
            <Stat
              label="PAYMENTS IN MESH"
              value={state ? String(packets).padStart(2, "0") : "—"}
              icon={<Send size={19} />}
              detail="Unique encrypted instructions"
              tone="purple"
            />
            <Stat
              label="SETTLED VOLUME"
              value={
                state
                  ? money(settled.reduce((sum, t) => sum + t.amount, 0))
                  : "—"
              }
              icon={<Wallet size={19} />}
              detail={`${settled.length} successful transactions`}
              tone="orange"
            />
            <Stat
              label="DUPLICATES BLOCKED"
              value={state ? String(state.duplicates).padStart(2, "0") : "—"}
              icon={<ShieldCheck size={19} />}
              detail="Every payment processed once"
              tone="blue"
            />
          </section>
          <div className="primary-grid">
            <section className="panel mesh-panel" id="mesh">
              <div className="panel-heading">
                <div>
                  <h2>
                    Live mesh network{" "}
                    <span className="live-tag">
                      <span /> LIVE
                    </span>
                  </h2>
                  <p>A small network. A new way to move money.</p>
                </div>
                <button
                  className="icon-button"
                  title="Clear mesh packets; keep balances and ledger"
                  aria-label="Reset mesh"
                  disabled={busy}
                  onClick={() => void act("reset")}
                >
                  <RotateCcw size={17} />
                </button>
              </div>
              <div className="mesh-canvas">
                <div className="mesh-caption">
                  <span className="signal-dot" /> BLUETOOTH GOSSIP SIMULATION
                </div>
                <svg
                  viewBox="0 0 560 330"
                  role="group"
                  aria-label="Interactive network: Alice connects to two relays, each connected to an internet bridge"
                >
                  <defs>
                    <pattern
                      id="dots"
                      x="0"
                      y="0"
                      width="18"
                      height="18"
                      patternUnits="userSpaceOnUse"
                    >
                      <circle cx="1" cy="1" r=".7" fill="#dce3dc" />
                    </pattern>
                  </defs>
                  <rect width="560" height="330" fill="url(#dots)" />
                  {[
                    [0, 1],
                    [0, 2],
                    [1, 3],
                    [2, 4],
                    [1, 2],
                  ].map(([a, b]) => {
                    const d1 = state?.devices[a],
                      d2 = state?.devices[b];
                    return (
                      d1 &&
                      d2 && (
                        <line
                          key={`${a}-${b}`}
                          x1={d1.x}
                          y1={d1.y}
                          x2={d2.x}
                          y2={d2.y}
                          className={
                            d1.packets.length && d2.packets.length
                              ? "mesh-edge traveling"
                              : "mesh-edge"
                          }
                        />
                      )
                    );
                  })}
                  {state?.devices.map((d) => (
                    <g
                      key={d.id}
                      className="mesh-node"
                      tabIndex={0}
                      role="button"
                      aria-label={`${d.name}, ${d.packets.length} packets, ${d.online ? "online" : "offline"}`}
                      onClick={() => setSelected(d.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(d.id);
                        }
                      }}
                    >
                      {d.id === selected && (
                        <circle
                          cx={d.x}
                          cy={d.y}
                          r="39"
                          className="node-halo"
                        />
                      )}
                      <circle
                        cx={d.x}
                        cy={d.y}
                        r="27"
                        className={
                          d.online
                            ? "node-circle bridge"
                            : d.id === "alice"
                              ? "node-circle sender"
                              : "node-circle"
                        }
                      />
                      <g
                        transform={`translate(${d.x - 10},${d.y - 12})`}
                        stroke={
                          d.id === "alice"
                            ? "#fff"
                            : d.online
                              ? "#2d735b"
                              : "#6e797b"
                        }
                        strokeWidth="1.6"
                        fill="none"
                      >
                        <rect width="20" height="24" rx="4" />
                        <path d="M7 20h6" />
                      </g>
                      {d.packets.length > 0 && (
                        <>
                          <circle
                            cx={d.x + 22}
                            cy={d.y - 22}
                            r="11"
                            fill="#d2ed72"
                          />
                          <text
                            x={d.x + 22}
                            y={d.y - 18}
                            textAnchor="middle"
                            className="packet-number"
                          >
                            {d.packets.length}
                          </text>
                        </>
                      )}
                      <text
                        x={d.x}
                        y={d.y + 48}
                        textAnchor="middle"
                        className="node-name"
                      >
                        {d.name}
                      </text>
                      <text
                        x={d.x}
                        y={d.y + 65}
                        textAnchor="middle"
                        className="node-status"
                      >
                        {d.online
                          ? "● Internet available"
                          : d.id === "alice"
                            ? "Payment origin"
                            : "Offline relay"}
                      </text>
                    </g>
                  ))}
                  {!state && (
                    <text
                      x="280"
                      y="165"
                      textAnchor="middle"
                      className="node-name"
                    >
                      Connecting to your mesh…
                    </text>
                  )}
                </svg>
                <div className="mesh-legend">
                  <span>
                    <i className="legend-dot offline" />
                    Offline device
                  </span>
                  <span>
                    <i className="legend-dot online" />
                    Internet bridge
                  </span>
                  <span>
                    <i className="legend-line" />
                    Mesh connection
                  </span>
                </div>
              </div>
              <div className="device-strip">
                <span className="device-strip-icon">
                  <Smartphone size={17} />
                </span>
                <div>
                  <strong>{device?.name ?? "Select a device"}</strong>
                  <span>
                    {device?.packets.length ?? 0} packets held ·{" "}
                    {device?.online
                      ? "Ready to upload"
                      : "Waiting for a nearby relay"}
                  </span>
                </div>
                <span className="round-label">ROUND {state?.rounds ?? 0}</span>
              </div>
              <div className="mesh-controls">
                <button
                  className="button light"
                  disabled={busy || !state}
                  onClick={() => void act("gossip")}
                >
                  <Radio size={16} />
                  Run gossip round
                </button>
                <button
                  className="button dark"
                  disabled={busy || !state}
                  onClick={() => void act("flush")}
                >
                  <Globe2 size={16} />
                  Upload via bridges
                  <ArrowRight size={15} />
                </button>
              </div>
            </section>
            <section className="panel payment-panel">
              <div className="panel-heading">
                <div>
                  <h2>Send a payment</h2>
                  <p>No internet? Start here.</p>
                </div>
                <span className="soft-icon green">
                  <ArrowUpRight size={20} />
                </span>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act("send");
                }}
              >
                <label htmlFor="sender">From account</label>
                <div className="select-wrap">
                  <span
                    className={`avatar ${state?.accounts.find((a) => a.vpa === sender)?.color ?? "purple"}`}
                  >
                    {state?.accounts.find((a) => a.vpa === sender)?.initials ??
                      "AL"}
                  </span>
                  <select
                    id="sender"
                    value={sender}
                    onChange={(e) => setSender(e.target.value)}
                  >
                    {(
                      state?.accounts ?? [{ vpa: "alice@demo", name: "Alice" }]
                    ).map((a) => (
                      <option key={a.vpa} value={a.vpa}>
                        {a.name} · {a.vpa}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </div>
                <div className="available">
                  Available balance{" "}
                  <strong>
                    {money(
                      state?.accounts.find((a) => a.vpa === sender)?.balance ??
                        0,
                    )}
                  </strong>
                </div>
                <label htmlFor="receiver">To account</label>
                <div className="select-wrap">
                  <span
                    className={`avatar ${state?.accounts.find((a) => a.vpa === receiver)?.color ?? "orange"}`}
                  >
                    {state?.accounts.find((a) => a.vpa === receiver)
                      ?.initials ?? "BO"}
                  </span>
                  <select
                    id="receiver"
                    value={receiver}
                    onChange={(e) => setReceiver(e.target.value)}
                  >
                    {(
                      state?.accounts ?? [{ vpa: "bob@demo", name: "Bob" }]
                    ).map((a) => (
                      <option key={a.vpa} value={a.vpa}>
                        {a.name} · {a.vpa}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </div>
                <label htmlFor="amount">Amount</label>
                <div className="amount-input">
                  <span>₹</span>
                  <input
                    id="amount"
                    type="text"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                    pattern="[0-9]{1,6}(\.[0-9]{1,2})?"
                    aria-describedby="payment-note"
                  />
                  <span className="currency">INR</span>
                </div>
                <div className="amount-presets">
                  {["100", "500", "1000"].map((a) => (
                    <button
                      type="button"
                      key={a}
                      className={a === amount ? "chosen" : ""}
                      onClick={() => setAmount(a)}
                    >
                      ₹{Number(a).toLocaleString("en-IN")}
                    </button>
                  ))}
                </div>
                <div className="encryption-note">
                  <LockKeyhole size={16} />
                  <div>
                    Encrypted before it leaves
                    <span>RSA-OAEP + AES-256-GCM</span>
                  </div>
                  <ShieldCheck size={18} />
                </div>
                <button
                  className="button lime send-button"
                  type="submit"
                  disabled={busy || !state}
                >
                  <Send size={16} />
                  Inject into mesh
                  <ArrowRight size={17} />
                </button>
                <p id="payment-note" className="payment-footnote">
                  This queues an instruction. Funds move only after a bridge
                  uploads it. Demo accounts only.
                </p>
              </form>
            </section>
          </div>
          <section className="panel accounts-panel" id="accounts">
            <div className="panel-heading">
              <div>
                <h2>Your demo accounts</h2>
                <p>A transparent ledger, down to the last rupee.</p>
              </div>
              <span className="subtle-label">4 SANDBOX ACCOUNTS</span>
            </div>
            <div className="accounts-grid">
              {state?.accounts.map((a) => (
                <div className="account-card" key={a.vpa}>
                  <div className="account-top">
                    <span className={`avatar ${a.color}`}>{a.initials}</span>
                    <div>
                      <strong>{a.name}</strong>
                      <span>{a.vpa}</span>
                    </div>
                    <span className="account-status">
                      <span />
                      Active
                    </span>
                  </div>
                  <div className="account-balance">{money(a.balance)}</div>
                  <span className="account-caption">AVAILABLE BALANCE</span>
                </div>
              )) ??
                Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="account-card skeleton" />
                ))}
            </div>
          </section>
          <div className="bottom-grid">
            <section className="panel ledger-panel" id="transactions">
              <div className="panel-heading">
                <div>
                  <h2>
                    Transaction ledger{" "}
                    <span className="count-badge">{transactions.length}</span>
                  </h2>
                  <p>Every delivery has a story. Here’s the record.</p>
                </div>
                <ArrowDownLeft size={19} className="muted" />
              </div>
              <div className="tabs">
                {(
                  [
                    { value: "all", label: "All payments" },
                    { value: "SETTLED", label: "Settled" },
                    { value: "REJECTED", label: "Rejected" },
                  ] as const
                ).map((t) => (
                  <button
                    className={tab === t.value ? "selected" : ""}
                    key={t.value}
                    onClick={() => setTab(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
                <span>Last 100 payments</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>PAYMENT</th>
                      <th>AMOUNT</th>
                      <th>STATUS</th>
                      <th>TIME</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <div className="transaction-person">
                            <span className="transaction-icon">
                              <ArrowUpRight size={17} />
                            </span>
                            <div>
                              <strong>
                                {t.sender.split("@")[0]}{" "}
                                <ArrowRight size={11} />{" "}
                                {t.receiver.split("@")[0]}
                              </strong>
                              <span>
                                {t.bridge} · {t.id.slice(0, 8)}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="table-amount">{money(t.amount)}</td>
                        <td>
                          <span
                            title={t.reason ?? "Committed to ledger"}
                            className={`status-badge ${t.status.toLowerCase()}`}
                          >
                            {t.status === "SETTLED" ? (
                              <Check size={12} />
                            ) : (
                              <X size={12} />
                            )}{" "}
                            {t.status === "SETTLED" ? "Settled" : "Rejected"}
                          </span>
                        </td>
                        <td className="table-time">{time(t.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!visible.length && (
                  <div className="empty-state">
                    <span>
                      <ArrowDownLeft size={23} />
                    </span>
                    <strong>
                      {transactions.length
                        ? "No payments in this view"
                        : "Your first payment starts a story"}
                    </strong>
                    <p>
                      {transactions.length
                        ? "Choose another filter to see your payments."
                        : "Send a payment, run two gossip rounds, then upload via bridges."}
                    </p>
                    {!transactions.length && (
                      <button
                        onClick={() => void act("demo")}
                        disabled={busy || !state}
                      >
                        Try the live demo <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>
            <section className="panel activity-panel">
              <div className="panel-heading">
                <div>
                  <h2>Network activity</h2>
                  <p>The mesh, moment by moment.</p>
                </div>
                <Activity size={18} className="muted" />
              </div>
              <div className="event-list" aria-live="polite">
                {state?.events.slice(0, 8).map((event) => (
                  <div className={`event ${event.kind}`} key={event.id}>
                    <span className="event-icon">
                      {event.kind === "settled" ? (
                        <Check size={14} />
                      ) : event.kind === "duplicate" ? (
                        <CheckCheck size={14} />
                      ) : event.kind === "payment" ? (
                        <Send size={14} />
                      ) : event.kind === "rejected" ? (
                        <X size={14} />
                      ) : (
                        <Radio size={14} />
                      )}
                    </span>
                    <div>
                      <p>{event.message}</p>
                      <time>{time(event.time)}</time>
                    </div>
                  </div>
                )) ?? (
                  <p className="loading-text">
                    Listening for network activity…
                  </p>
                )}
              </div>
            </section>
          </div>
          <footer>
            <div>
              <span className="environment-dot" />
              All systems local <span className="footer-divider">/</span> Built
              for curiosity.
            </div>
            <span>Simulated mesh · Deferred settlement · No real money</span>
          </footer>
        </main>
      </div>
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              autoFocus
              className="modal-close icon-button"
              onClick={() => setHelp(false)}
              aria-label="Close help"
            >
              <X size={20} />
            </button>
            <span className="soft-icon green">
              <Network size={25} />
            </span>
            <h2 id="help-title">A payment’s journey</h2>
            <p>
              This is a local simulator of mesh-routed deferred payments, with a
              persistent demo ledger.
            </p>
            <ol>
              <li>
                <strong>Compose & encrypt</strong>
                <span>
                  Choose demo accounts and an amount. The server simulates a
                  sender encrypting an instruction.
                </span>
              </li>
              <li>
                <strong>Let the mesh carry it</strong>
                <span>
                  Run two gossip rounds. Nearby relays pass the opaque packet to
                  internet bridges.
                </span>
              </li>
              <li>
                <strong>Upload & settle once</strong>
                <span>
                  Both bridges deliver the packet. One settles; the duplicate is
                  dropped.
                </span>
              </li>
            </ol>
            <p className="help-note">
              Reset mesh clears packets and session counters; it keeps balances
              and transactions. Run live demo transfers ₹500 from Alice to Bob
              each time. Sender authentication and physical Bluetooth are
              outside this demo.
            </p>
            <button className="button dark" onClick={() => setHelp(false)}>
              Let’s explore <ArrowRight size={16} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  icon,
  detail,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  detail: string;
  tone: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <span className={`soft-icon ${tone}`}>{icon}</span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-detail">
        <span className={`tiny-dot ${tone}`} />
        {detail}
      </div>
    </div>
  );
}
