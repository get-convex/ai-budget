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
  const [tab, setTab] = useState<
    "requests" | "users" | "actions" | "experiment"
  >("requests");

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
          <button
            className={tab === "experiment" ? "" : "ghost"}
            onClick={() => setTab("experiment")}
          >
            🧪 Experiment
          </button>
          <Totals />
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {tab === "requests" ? (
            <Requests />
          ) : tab === "users" ? (
            <Users />
          ) : tab === "actions" ? (
            <Actions />
          ) : (
            <Experiment userId={userId} />
          )}
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
    // prior turns become history so the stored request holds the full chain
    const history = entries
      .filter((e) => e.who !== "error")
      .map((e) => ({ role: e.who === "user" ? "user" : "assistant", content: e.text }));
    push({ who: "user", text: prompt });
    setBusy(true);
    try {
      const res = await send({ userId, prompt, history, model });
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
                {r.cachedTokens ? (
                  <span title="prompt tokens served from cache" style={{ color: "var(--green)", marginLeft: 6 }}>
                    ⚡{r.cachedTokens}
                  </span>
                ) : null}
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
  // default diff on when this request is a re-run of another
  const [diff, setDiff] = useState(!!request.rerunOf);
  // the request this one was changed from (immediate parent in the chain)
  const original = lineage?.ancestors?.[lineage.ancestors.length - 1];

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
        {original && (
          <button
            className={diff ? "" : "ghost"}
            style={{ marginBottom: 10 }}
            onClick={() => setDiff((d) => !d)}
          >
            {diff ? "✕ hide diff" : "⇄ diff vs original"}
          </button>
        )}
        {diff && original ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              <span style={{ color: "var(--muted)" }}>model: </span>
              <span className="mono" style={{ color: original.model === request.model ? "var(--muted)" : "var(--red)" }}>
                {original.model}
              </span>
              {" → "}
              <span className="mono" style={{ color: original.model === request.model ? "var(--muted)" : "var(--green)" }}>
                {request.model}
              </span>
              {original.model === request.model && <span style={{ color: "var(--muted)" }}> (unchanged)</span>}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
              prompt diff <span style={{ color: "var(--red)" }}>original</span> →{" "}
              <span style={{ color: "var(--green)" }}>this</span>
            </div>
            {mergeRoles(original.messages, messages).map((pair, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 11, color: "var(--muted)" }}>{pair.role}</label>
                <div style={{ background: "var(--panel2)", borderRadius: 6, padding: 8, whiteSpace: "pre-wrap", fontSize: 13 }}>
                  <DiffText a={pair.a} b={pair.b} />
                </div>
              </div>
            ))}
            <div style={{ fontSize: 12, color: "var(--muted)", margin: "10px 0 6px" }}>output diff</div>
            <div style={{ background: "var(--panel2)", borderRadius: 6, padding: 8, whiteSpace: "pre-wrap", fontSize: 13 }}>
              <DiffText a={original.responseText ?? ""} b={request.responseText ?? ""} />
            </div>
          </div>
        ) : (
          <>
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
                  response · {cents(request.costNanos)}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{request.responseText}</div>
              </div>
            )}
          </>
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

// ---------- diff ----------

// Pair up messages by position for a side-by-side prompt diff.
function mergeRoles(
  a: { role: string; content: string }[] = [],
  b: { role: string; content: string }[] = []
) {
  const n = Math.max(a.length, b.length);
  const out: { role: string; a: string; b: string }[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: b[i]?.role ?? a[i]?.role ?? "",
      a: a[i]?.content ?? "",
      b: b[i]?.content ?? "",
    });
  }
  return out;
}

// Word-level LCS diff, rendered with removals struck red and additions green.
function DiffText({ a, b }: { a: string; b: string }) {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  const m = A.length,
    n = B.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const parts: { t: string; k: "same" | "del" | "add" }[] = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { parts.push({ t: A[i], k: "same" }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { parts.push({ t: A[i], k: "del" }); i++; }
    else { parts.push({ t: B[j], k: "add" }); j++; }
  }
  while (i < m) parts.push({ t: A[i++], k: "del" });
  while (j < n) parts.push({ t: B[j++], k: "add" });
  if (a === b) return <span style={{ color: "var(--muted)" }}>{a || "(empty)"}</span>;
  return (
    <>
      {parts.map((p, idx) =>
        p.k === "same" ? (
          <span key={idx}>{p.t}</span>
        ) : p.k === "del" ? (
          <span key={idx} style={{ color: "var(--red)", textDecoration: "line-through" }}>{p.t}</span>
        ) : (
          <span key={idx} style={{ color: "var(--green)" }}>{p.t}</span>
        )
      )}
    </>
  );
}

// ---------- experiment ----------

const DEFAULT_SYSTEMS = [
  "You are a concise, friendly assistant. Keep replies short.",
  "You are a witty assistant who answers in a single vivid sentence.",
];

function Experiment({ userId }: { userId: string }) {
  const [mode, setMode] = useState<"matrix" | "backtest" | "evolve">("matrix");
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button className={mode === "matrix" ? "" : "ghost"} onClick={() => setMode("matrix")}>
          Prompt × model matrix
        </button>
        <button className={mode === "backtest" ? "" : "ghost"} onClick={() => setMode("backtest")}>
          Backtest on real traffic
        </button>
        <button className={mode === "evolve" ? "" : "ghost"} onClick={() => setMode("evolve")}>
          🧬 Evolve (budget-bounded)
        </button>
      </div>
      {mode === "matrix" ? <Matrix userId={userId} /> : mode === "backtest" ? <Backtest /> : <Evolve />}
    </div>
  );
}

function Evolve() {
  const evolve = useAction(api.ai.evolve);
  const tunable = useTunableActions();
  const [action, setAction] = useState("ai:sendMessage");
  const [goal, setGoal] = useState("Explain like I'm five, warmly, with a concrete analogy.");
  const [seedSystem, setSeedSystem] = useState("You are a helpful assistant.");
  const [rounds, setRounds] = useState(5);
  const [budget, setBudget] = useState(0.02); // dollars
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setOut(null);
    try {
      setOut(await evolve({ action, goal, seedSystem, rounds, sampleSize: 2, budgetNanos: Math.round(budget * NANOS) }));
    } catch (e: any) {
      setOut({ error: String(e?.data?.reason ?? e?.message ?? e) });
    } finally { setBusy(false); }
  };
  const maxScore = 10;
  return (
    <div style={{ maxWidth: 900 }}>
      <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 10 }}>
        An LLM evolves the system prompt for a chosen feature (action) toward your goal,
        scoring each candidate on <b>that feature's</b> real requests. It runs until the
        round limit <b>or the budget</b> — the spend cap is what makes an autonomous
        optimization loop safe to walk away from.
      </p>
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>action (feature to tune) </label>
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          {[action, ...tunable.filter((a: string) => a !== action)].map((a: string) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </div>
      <label style={{ fontSize: 12, color: "var(--muted)" }}>goal</label>
      <textarea style={{ width: "100%", minHeight: 40, marginBottom: 8 }} value={goal} onChange={(e) => setGoal(e.target.value)} />
      <label style={{ fontSize: 12, color: "var(--muted)" }}>seed system prompt</label>
      <textarea style={{ width: "100%", minHeight: 40, marginBottom: 8 }} value={seedSystem} onChange={(e) => setSeedSystem(e.target.value)} />
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>max rounds</label>
        <input type="number" style={{ width: 56 }} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} />
        <label style={{ fontSize: 12, color: "var(--muted)" }}>budget $</label>
        <input type="number" step="0.01" style={{ width: 70 }} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
        <button onClick={run} disabled={busy}>{busy ? "Evolving…" : "🧬 Evolve"}</button>
      </div>
      {out?.error && <div style={{ color: "var(--red)" }}>{out.error}</div>}
      {out?.history && (
        <>
          <div style={{ marginBottom: 12, fontSize: 13 }}>
            stopped by{" "}
            <b style={{ color: out.stopped === "budget" ? "var(--accent2)" : "var(--muted)" }}>
              {out.stopped === "budget" ? "🛑 budget reached" : "round limit"}
            </b>{" "}
            · spent <b>{cents(out.spentNanos)}</b> · corpus {out.corpusSize} real requests
          </div>
          {out.history.map((h: any) => {
            const isBest = h.system === out.best.system;
            return (
              <div key={h.round} style={{
                display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0",
                borderBottom: "1px solid var(--border)",
              }}>
                <div className="mono" style={{ width: 60, color: "var(--muted)", fontSize: 12 }}>#{h.round}</div>
                <div style={{ width: 120 }}>
                  <div style={{ background: "var(--panel2)", borderRadius: 4, height: 8, overflow: "hidden" }}>
                    <div style={{ width: `${(h.score / maxScore) * 100}%`, height: "100%", background: isBest ? "var(--green)" : "var(--accent)" }} />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{h.score.toFixed(1)}/10 · {cents(h.spentNanos)}</div>
                </div>
                <div style={{ flex: 1, fontSize: 13 }}>
                  {isBest && <span style={{ color: "var(--green)" }}>★ </span>}
                  {h.system}
                </div>
              </div>
            );
          })}
          <div style={{ marginTop: 14, background: "var(--panel2)", border: "1px solid var(--green)", borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 12, color: "var(--green)", marginBottom: 4 }}>best prompt · {out.best.score.toFixed(1)}/10</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{out.best.system}</div>
          </div>
        </>
      )}
    </div>
  );
}

// Actions worth tuning — real features, not the meta eval actions.
function useTunableActions() {
  const actions = useQuery(api.ai.listActions) ?? [];
  return actions
    .map((a: any) => a.name)
    .filter((n: string) => !/^ai:(backtest|judge|evolve|experiment)$/.test(n));
}

function Backtest() {
  const backtest = useAction(api.ai.backtest);
  const tunable = useTunableActions();
  const [action, setAction] = useState("ai:sendMessage");
  const [newSystem, setNewSystem] = useState(
    "You are a warm, encouraging assistant. Answer with a concrete example."
  );
  const [model, setModel] = useState("");
  const [limit, setLimit] = useState(5);
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setOut(null);
    try {
      setOut(await backtest({ action, newSystem, model: model || undefined, limit }));
    } catch (e: any) {
      setOut({ error: String(e?.data?.reason ?? e?.message ?? e) });
    } finally { setBusy(false); }
  };
  return (
    <div style={{ maxWidth: 1000 }}>
      <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 10 }}>
        Pick a feature (action), then replay a new system prompt against <b>its</b> last N
        real requests and let a judge decide whether it improved each one. Each feature
        has its own prompt, so each is backtested separately. Budget-capped.
      </p>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>action (feature to tune) </label>
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          {[action, ...tunable.filter((a: string) => a !== action)].map((a: string) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </div>
      <label style={{ fontSize: 12, color: "var(--muted)" }}>candidate system prompt</label>
      <textarea style={{ width: "100%", minHeight: 54, marginBottom: 10 }} value={newSystem} onChange={(e) => setNewSystem(e.target.value)} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14 }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>model override</label>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">(keep original)</option>
          {MODELS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>last</label>
        <input type="number" style={{ width: 56 }} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        <button onClick={run} disabled={busy}>{busy ? "Backtesting…" : "▶ Backtest"}</button>
      </div>
      {out?.error && <div style={{ color: "var(--red)" }}>{out.error}</div>}
      {out?.results && (
        <>
          <div style={{ background: "var(--panel2)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <b style={{ color: "var(--green)" }}>{out.improved} improved</b>
            {" · "}<b style={{ color: "var(--red)" }}>{out.regressed} regressed</b>
            {" · "}{out.total - out.improved - out.regressed} tie · over {out.total} real requests
          </div>
          {out.results.map((r: any, i: number) => (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                {r.error ? "🚫 " + r.error : <><b>prompt:</b> {r.prompt.slice(0, 120)}</>}
              </div>
              {!r.error && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, color: r.better === "original" ? "var(--green)" : "var(--muted)" }}>original {r.better === "original" && "✓"}</div>
                      <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{r.original}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: r.better === "new" ? "var(--green)" : "var(--muted)" }}>new {r.better === "new" && "✓"}</div>
                      <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}><DiffText a={r.original} b={r.updated} /></div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--accent2)", marginTop: 6 }}>
                    judge: <b>{r.better}</b> — {r.why} · {cents(r.costNanos)}
                  </div>
                </>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Matrix({ userId }: { userId: string }) {
  const experiment = useAction(api.ai.experiment);
  const judge = useAction(api.ai.judge);
  const [prompt, setPrompt] = useState("Explain recursion to a five-year-old.");
  const [systems, setSystems] = useState<string[]>(DEFAULT_SYSTEMS);
  const [models, setModels] = useState<string[]>(["openai/gpt-4o-mini", "openai/gpt-4o"]);
  const [results, setResults] = useState<any[] | null>(null);
  const [verdict, setVerdict] = useState<any>(null);
  const [busy, setBusy] = useState<"" | "run" | "judge">("");

  const toggleModel = (m: string) =>
    setModels((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m]));

  const run = async () => {
    setBusy("run"); setResults(null); setVerdict(null);
    try {
      setResults(await experiment({ userId, prompt, systems: systems.filter((s) => s.trim()), models }));
    } finally { setBusy(""); }
  };
  const doJudge = async () => {
    if (!results) return;
    setBusy("judge");
    try {
      const candidates = results
        .filter((r) => r.text)
        .map((r, i) => ({ label: String.fromCharCode(65 + i), text: r.text }));
      setVerdict(await judge({ prompt, candidates }));
    } finally { setBusy(""); }
  };
  // winner may come back as "B" or "Candidate B" — match the trailing token.
  const wins = (label: string) =>
    !!verdict?.winner && String(verdict.winner).trim().split(/\s+/).pop() === label;

  return (
    <div style={{ maxWidth: 1100 }}>
      <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 10 }}>
        Run one prompt across every <b>system prompt × model</b> combination — every
        cell is a tracked, budgeted request — then let a judge model pick the best.
      </p>
      <label style={{ fontSize: 12, color: "var(--muted)" }}>prompt</label>
      <textarea style={{ width: "100%", minHeight: 54, marginBottom: 10 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <label style={{ fontSize: 12, color: "var(--muted)" }}>system prompt variants</label>
      {systems.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <textarea style={{ flex: 1, minHeight: 34 }} value={s}
            onChange={(e) => setSystems(systems.map((x, j) => (j === i ? e.target.value : x)))} />
          <button className="ghost" onClick={() => setSystems(systems.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="ghost" style={{ marginBottom: 10 }} onClick={() => setSystems([...systems, ""])}>+ variant</button>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: "var(--muted)" }}>models (A/B)</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          {MODELS.map((m) => (
            <label key={m} style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={models.includes(m)} onChange={() => toggleModel(m)} /> {m}
            </label>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button onClick={run} disabled={busy !== "" || !models.length}>
          {busy === "run" ? "Running…" : `▶ Run ${systems.filter((s) => s.trim()).length * models.length} variants`}
        </button>
        {results && (
          <button className="ghost" onClick={doJudge} disabled={busy !== ""}>
            {busy === "judge" ? "Judging…" : "⚖️ Judge the outputs"}
          </button>
        )}
      </div>

      {verdict && (
        <div style={{ background: "var(--panel2)", border: "1px solid var(--accent)", borderRadius: 8, padding: 12, marginBottom: 14 }}>
          <b style={{ color: "var(--accent2)" }}>Winner: {verdict.winner ?? "—"}</b> · {verdict.rationale}
          {verdict.ranking?.length ? (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>ranking: {verdict.ranking.join(" > ")}</div>
          ) : null}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
        {results?.map((r, i) => {
          const label = String.fromCharCode(65 + i);
          return (
            <div key={i} style={{
              background: "var(--panel)", border: `1px solid ${wins(label) ? "var(--green)" : "var(--border)"}`,
              borderRadius: 10, padding: 12,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                <span className="mono"><b>{label}</b> · {r.model.split("/")[1]}</span>
                {wins(label) && <span style={{ color: "var(--green)" }}>★ best</span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", margin: "4px 0", fontStyle: "italic" }}>
                {r.system}
              </div>
              {r.error ? (
                <div style={{ color: "var(--red)", fontSize: 13 }}>🚫 {r.error}</div>
              ) : (
                <>
                  <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{r.text}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
                    {cents(r.costNanos)} · {r.promptTokens}→{r.completionTokens} tok
                    {r.cachedTokens ? <span style={{ color: "var(--green)" }}> ⚡{r.cachedTokens}</span> : null}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
