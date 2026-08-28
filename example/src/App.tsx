import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const PERSONAS = ["alice", "bob", "mallory"];
const MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.5",
];

// All money is integer nanodollars (1 USD = 1e9).
const NANOS = 1e9;
const usd = (nanos: number | undefined) =>
  nanos === undefined ? "—" : `$${(nanos / NANOS).toFixed(nanos < NANOS / 100 ? 6 : 2)}`;
// aliases kept so existing call sites render nanodollars as USD
const cents = usd;
const dollars = usd;

type ChatEntry = {
  who: "user" | "ai" | "error";
  text: string;
  costNanos?: number;
  warnings?: string[];
};

export default function App() {
  const [userId, setUserId] = useState(PERSONAS[0]);
  const [model, setModel] = useState(MODELS[0]);
  const [tab, setTab] = useState<"requests" | "users" | "actions">("requests");

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div
        style={{
          width: 420,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          background: "var(--panel)",
        }}
      >
        <header style={{ padding: 16, borderBottom: "1px solid var(--border)" }}>
          <h1 style={{ fontSize: 18 }}>
            ☂️ Worry-Free AI{" "}
            <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>
              convex component demo
            </span>
          </h1>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              {PERSONAS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{ flex: 1 }}
            >
              {MODELS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
        </header>
        <Chat userId={userId} model={model} />
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            alignItems: "center",
          }}
        >
          <strong style={{ marginRight: 8 }}>Admin</strong>
          <button
            className={tab === "requests" ? "" : "ghost"}
            onClick={() => setTab("requests")}
          >
            Requests
          </button>
          <button
            className={tab === "users" ? "" : "ghost"}
            onClick={() => setTab("users")}
          >
            Users & Limits
          </button>
          <button
            className={tab === "actions" ? "" : "ghost"}
            onClick={() => setTab("actions")}
          >
            Actions & Budgets
          </button>
          <Totals />
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {tab === "requests" ? <Requests /> : tab === "users" ? <Users /> : <Actions />}
        </div>
      </div>
    </div>
  );
}

function Chat({ userId, model }: { userId: string; model: string }) {
  const send = useAction(api.ai.sendMessage);
  const summarize = useAction(api.ai.summarize);
  const [log, setLog] = useState<Record<string, ChatEntry[]>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const entries = log[userId] ?? [];

  const push = (entry: ChatEntry) =>
    setLog((l) => ({ ...l, [userId]: [...(l[userId] ?? []), entry] }));

  const submit = async () => {
    if (!input.trim() || busy) return;
    const prompt = input;
    setInput("");
    push({ who: "user", text: prompt });
    setBusy(true);
    try {
      const res = await send({ userId, prompt, model });
      push({ who: "ai", text: res.text, costNanos: res.costNanos, warnings: res.warnings });
    } catch (e: any) {
      const data = e?.data;
      push({
        who: "error",
        text: data?.kind === "AIBudgetLimit" ? `🚫 ${data.reason}` : String(e?.message ?? e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {entries.length === 0 && (
          <div style={{ color: "var(--muted)", textAlign: "center", marginTop: 40 }}>
            Chat as <b>{userId}</b> — every call is tracked, priced, and limit-checked.
          </div>
        )}
        {entries.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.who === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%",
              background:
                m.who === "user"
                  ? "var(--accent)"
                  : m.who === "error"
                    ? "#3a1420"
                    : "var(--panel2)",
              color: m.who === "error" ? "var(--red)" : "var(--text)",
              borderRadius: 12,
              padding: "8px 12px",
              whiteSpace: "pre-wrap",
            }}
          >
            {m.text}
            {m.warnings && m.warnings.length > 0 && (
              <div style={{ fontSize: 11, color: "var(--accent2)", marginTop: 4 }}>
                {m.warnings.map((w, j) => (
                  <div key={j}>⚠ {w}</div>
                ))}
              </div>
            )}
            {m.costNanos !== undefined && (
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                cost: {cents(m.costNanos)}
              </div>
            )}
          </div>
        ))}
        {busy && <div style={{ color: "var(--muted)" }}>thinking…</div>}
      </div>
      <div style={{ display: "flex", gap: 8, padding: 16, borderTop: "1px solid var(--border)" }}>
        <input
          style={{ flex: 1 }}
          value={input}
          placeholder={`Message as ${userId}…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button onClick={submit} disabled={busy}>
          Send
        </button>
        <button
          className="ghost"
          disabled={busy || entries.length === 0}
          title="A second action name, to demo per-action budgets"
          onClick={async () => {
            setBusy(true);
            try {
              const text = entries.map((e) => `${e.who}: ${e.text}`).join("\n");
              const res = await summarize({ userId, text });
              push({ who: "ai", text: `📝 ${res.text}`, costNanos: res.costNanos });
            } catch (e: any) {
              const data = e?.data;
              push({
                who: "error",
                text: data?.kind === "AIBudgetLimit" ? `🚫 ${data.reason}` : String(e?.message ?? e),
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          📝
        </button>
      </div>
    </>
  );
}

function Totals() {
  const users = useQuery(api.ai.listUsers) ?? [];
  const total = users.reduce((s: number, u: any) => s + u.totalSpendNanos, 0);
  const requests = users.reduce((s: number, u: any) => s + u.totalRequests, 0);
  return (
    <div style={{ marginLeft: "auto", color: "var(--muted)", fontSize: 13 }}>
      {requests} requests · total spend <b style={{ color: "var(--accent2)" }}>{dollars(total)}</b>
    </div>
  );
}

function Requests() {
  const requests = useQuery(api.ai.listRequests, {}) ?? [];
  const [selected, setSelected] = useState<any>(null);
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>user</th>
            <th>action</th>
            <th>model</th>
            <th>status</th>
            <th>tokens</th>
            <th>cost</th>
            <th>latency</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r: any) => (
            <tr key={r._id}>
              <td className="mono">{new Date(r._creationTime).toLocaleTimeString()}</td>
              <td>{r.userId}</td>
              <td className="mono">{r.actionName ?? "—"}</td>
              <td className="mono">
                {r.model}
                {r.unpricedModel && (
                  <span
                    title="No known price — charged the conservative fallback. Add a price via setPrice."
                    style={{ marginLeft: 6, color: "var(--accent2)" }}
                  >
                    ⚠ unpriced
                  </span>
                )}
              </td>
              <td>
                <span className={`pill ${r.status}`}>{r.status}</span>
                {r.rerunOf && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--muted)" }}>rerun</span>}
              </td>
              <td className="mono">
                {r.promptTokens !== undefined ? `${r.promptTokens}→${r.completionTokens}` : "—"}
              </td>
              <td className="mono">{cents(r.costNanos)}</td>
              <td className="mono">{r.latencyMs ? `${r.latencyMs}ms` : "—"}</td>
              <td>
                <button className="ghost" onClick={() => setSelected(r)}>
                  inspect
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <Inspector
          key={selected._id}
          request={selected}
          onClose={() => setSelected(null)}
          onOpen={setSelected}
        />
      )}
    </>
  );
}

function Inspector({
  request,
  onClose,
  onOpen,
}: {
  request: any;
  onClose: () => void;
  onOpen: (r: any) => void;
}) {
  const rerun = useAction(api.ai.rerun);
  const lineage = useQuery(api.ai.lineage, { requestId: request._id });
  const [messages, setMessages] = useState<{ role: string; content: string }[]>(
    request.messages
  );
  const [model, setModel] = useState(request.model);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await rerun({ requestId: request._id, messages, model }));
    } catch (e: any) {
      setResult({ error: String(e?.data?.reason ?? e?.message ?? e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12,
          width: 640, maxHeight: "85vh", overflow: "auto", padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ fontSize: 16 }}>
            Request by <b>{request.userId}</b>{" "}
            <span className={`pill ${request.status}`}>{request.status}</span>
          </h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        {lineage && (lineage.ancestors.length > 0 || lineage.reruns.length > 0) && (
          <div
            style={{
              background: "var(--panel2)",
              borderRadius: 8,
              padding: 10,
              marginBottom: 12,
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              alignItems: "center",
              fontSize: 12,
            }}
          >
            <span style={{ color: "var(--muted)" }}>lineage:</span>
            {lineage.ancestors.map((a: any) => (
              <span key={a._id}>
                <button className="ghost" onClick={() => onOpen(a)}>
                  {new Date(a._creationTime).toLocaleTimeString()} · {a.model.split("/")[1]} · {cents(a.costNanos)}
                </button>{" "}
                →
              </span>
            ))}
            <span
              style={{
                border: "1px solid var(--accent)",
                borderRadius: 8,
                padding: "4px 8px",
                color: "var(--accent2)",
              }}
            >
              this one
            </span>
            {lineage.reruns.map((r: any) => (
              <span key={r._id}>
                →{" "}
                <button className="ghost" onClick={() => onOpen(r)}>
                  {new Date(r._creationTime).toLocaleTimeString()} · {r.model.split("/")[1]} · {cents(r.costNanos)}
                </button>
              </span>
            ))}
          </div>
        )}
        <label style={{ fontSize: 12, color: "var(--muted)" }}>model</label>
        <select value={model} onChange={(e) => setModel(e.target.value)} style={{ width: "100%", marginBottom: 10 }}>
          {MODELS.map((m) => <option key={m}>{m}</option>)}
        </select>
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>{m.role}</label>
            <textarea
              style={{ width: "100%", minHeight: 60 }}
              value={m.content}
              onChange={(e) =>
                setMessages(messages.map((mm, j) => (j === i ? { ...mm, content: e.target.value } : mm)))
              }
            />
          </div>
        ))}
        {request.responseText && (
          <div style={{ background: "var(--panel2)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              original response · {cents(request.costNanos)}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{request.responseText}</div>
          </div>
        )}
        {request.error && (
          <div style={{ color: "var(--red)", marginBottom: 10 }}>{request.error}</div>
        )}
        <button onClick={run} disabled={busy}>
          {busy ? "Re-running…" : "▶ Re-run with edits"}
        </button>
        {result && (
          <div style={{ background: "var(--panel2)", borderRadius: 8, padding: 10, marginTop: 10 }}>
            {result.error ? (
              <div style={{ color: "var(--red)" }}>{result.error}</div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "var(--accent2)" }}>
                  new response · {cents(result.costNanos)}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{result.text}</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Users() {
  const users = useQuery(api.ai.listUsers) ?? [];
  const setLimits = useMutation(api.ai.setLimits);
  const bumpUser = useMutation(api.ai.bumpUser);
  return (
    <table>
      <thead>
        <tr>
          <th>user</th>
          <th>requests</th>
          <th>tokens</th>
          <th>spend today</th>
          <th>total spend</th>
          <th>req/min</th>
          <th>daily $</th>
          <th>daily tokens</th>
          <th>soft</th>
          <th>blocked</th>
          <th>bump</th>
        </tr>
      </thead>
      <tbody>
        {users.map((u: any) => (
          <tr key={u._id}>
            <td><b>{u.userId}</b></td>
            <td className="mono">{u.totalRequests}</td>
            <td className="mono">{u.totalTokens.toLocaleString()}</td>
            <td className="mono">{dollars(u.spendTodayNanos)}</td>
            <td className="mono">{dollars(u.totalSpendNanos)}</td>
            <td>
              <LimitInput
                value={u.requestsPerMinute}
                onSave={(n) => setLimits({ userId: u.userId, requestsPerMinute: n })}
              />
            </td>
            <td>
              <MoneyInput
                value={u.dailySpendLimitNanos}
                onSave={(n) => setLimits({ userId: u.userId, dailySpendLimitNanos: n })}
              />
            </td>
            <td>
              <LimitInput
                value={u.dailyTokenLimit}
                onSave={(n) => setLimits({ userId: u.userId, dailyTokenLimit: n })}
              />
            </td>
            <td title="Soft = warn but allow; unchecked = hard block">
              <input
                type="checkbox"
                checked={u.enforcement === "soft"}
                onChange={(e) =>
                  setLimits({ userId: u.userId, enforcement: e.target.checked ? "soft" : "hard" })
                }
              />
            </td>
            <td>
              <input
                type="checkbox"
                checked={!!u.blocked}
                onChange={(e) => setLimits({ userId: u.userId, blocked: e.target.checked })}
              />
            </td>
            <td title="One-time bump: approve another $1 of daily budget">
              <button
                className="ghost"
                onClick={() => bumpUser({ userId: u.userId, dailyNanos: NANOS })}
              >
                +$1 today
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Actions() {
  const actions = useQuery(api.ai.listActions) ?? [];
  const setLimits = useMutation(api.ai.setActionLimits);
  return (
    <>
      <p style={{ color: "var(--muted)", marginBottom: 12, fontSize: 13 }}>
        Spend is auto-attributed to the calling Convex action (via{" "}
        <code>ctx.meta</code>) — no manual tagging. Set a budget per feature.
      </p>
      <table>
        <thead>
          <tr>
            <th>action</th>
            <th>requests</th>
            <th>tokens</th>
            <th>spend today</th>
            <th>total spend</th>
            <th>daily limit ($)</th>
            <th>disabled</th>
          </tr>
        </thead>
        <tbody>
          {actions.map((a: any) => (
            <tr key={a._id}>
              <td className="mono"><b>{a.name}</b></td>
              <td className="mono">{a.totalRequests}</td>
              <td className="mono">{a.totalTokens.toLocaleString()}</td>
              <td className="mono">{dollars(a.spendTodayNanos)}</td>
              <td className="mono">{dollars(a.totalSpendNanos)}</td>
              <td>
                <MoneyInput
                  value={a.dailySpendLimitNanos}
                  onSave={(n) => setLimits({ name: a.name, dailySpendLimitNanos: n })}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={!!a.disabled}
                  onChange={(e) => setLimits({ name: a.name, disabled: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function LimitInput({
  value,
  onSave,
}: {
  value: number | undefined;
  onSave: (n: number | undefined) => void;
}) {
  const [text, setText] = useState(value?.toString() ?? "");
  return (
    <input
      style={{ width: 80 }}
      placeholder="∞"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onSave(text === "" ? undefined : Number(text))}
      onKeyDown={(e) =>
        e.key === "Enter" && onSave(text === "" ? undefined : Number(text))
      }
    />
  );
}

// A limit stored in nanodollars but edited in dollars.
function MoneyInput({
  value,
  onSave,
}: {
  value: number | undefined;
  onSave: (nanos: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : (value / NANOS).toString());
  const save = () =>
    onSave(text === "" ? undefined : Math.round(Number(text) * NANOS));
  return (
    <input
      style={{ width: 80 }}
      placeholder="∞ $"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && save()}
    />
  );
}
