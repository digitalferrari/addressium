import { useAsync } from "../useAsync.js";
import { api } from "../api.js";
import { SendingIdentity } from "./SendingIdentity.js";
import { SkeletonCard } from "../Skeleton.js";

/**
 * The checklist below is computed purely from data we own (`computeSetupState`),
 * which is why its "Sending domain" step means only "a domain is on the org
 * record". `<SendingIdentity>` is the other half (#285): the live SES read that
 * says whether that domain has actually verified and whether the account is out
 * of the sandbox — the two facts that decide if mail goes out at all. It is
 * rendered ALONGSIDE the checklist rather than folded into it, because a step
 * that flipped on a live third-party read would make the checklist's own
 * completeness depend on SES being reachable.
 */
export function Setup({ org }: { org: string }) {
  const { data, error, loading } = useAsync(() => api.setup(org), [org]);
  return (
    <div>
      <h1 className="h1">Setup · {org || "—"}</h1>
      {loading && <SkeletonCard lines={4} />}
      {error && <p className="err">{error}</p>}
      {data && (
        <>
          <div className="card">
            <div className="muted">
              {data.complete
                ? "All required steps complete — this organization is ready to send."
                : `${data.requiredDone} of ${data.requiredTotal} required steps complete.`}
            </div>
          </div>
          <div className="card">
            <table>
              <thead><tr><th></th><th>Step</th><th></th><th>How</th></tr></thead>
              <tbody>
                {data.steps.map((s) => (
                  <tr key={s.id}>
                    <td style={{ width: 24 }}>{s.done ? "✓" : "○"}</td>
                    <td className="t-strong">{s.label}</td>
                    <td className="muted">{s.required ? "required" : "recommended"}</td>
                    <td className="muted">{s.done ? "—" : s.hint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {/*
        Outside the `data &&` guard on purpose: "can this org send?" is the
        question an operator opens this screen to answer, and it must survive the
        checklist read failing. The two reads are independent — one is our table,
        one is SES — so one being down should not blank the other.
      */}
      <SendingIdentity org={org} />
    </div>
  );
}
