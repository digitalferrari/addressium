import { useMemo, useState } from "react";
// Subpath import, NOT the package barrel: the barrel re-exports modules that
// import node:crypto, which the browser bundle cannot resolve. The cost model
// itself is pure arithmetic.
import {
  estimateSendCost,
  DEFAULT_COST_INPUT,
  type SendCostInput,
  type CostLine,
} from "@addressium/domain/cost";

/**
 * Cost estimator (#213). Runs the SAME `estimateSendCost` model the README and
 * the domain tests use, so a number shown here cannot drift from a number
 * quoted elsewhere. Purely client-side — no API call, no stored state.
 *
 * Every line shows its arithmetic. An estimate you can't argue with is one
 * people either over-trust or ignore.
 */
export function CostEstimator() {
  const [input, setInput] = useState<SendCostInput>({ ...DEFAULT_COST_INPUT, sendsPerYear: 52 });
  const est = useMemo(() => estimateSendCost(input), [input]);

  const num = (key: keyof SendCostInput, label: string, hint?: string, step = 1) => (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span style={{ display: "block", fontSize: 13 }}>{label}</span>
      <input
        type="number"
        min={0}
        step={step}
        value={String(input[key])}
        onChange={(e) => setInput({ ...input, [key]: Number(e.target.value) })}
        style={{ width: 140 }}
      />
      {hint && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{hint}</span>}
    </label>
  );

  const usd = (n: number) => `$${n.toFixed(2)}`;
  const preset = (label: string, sendsPerYear: number) => (
    <button
      type="button"
      onClick={() => setInput({ ...input, sendsPerYear })}
      style={{ marginRight: 8, fontWeight: input.sendsPerYear === sendsPerYear ? 700 : 400 }}
    >
      {label}
    </button>
  );

  return (
    <section>
      <h2>Cost estimator</h2>
      <p className="muted">
        Estimated AWS cost of sending, at <strong>us-east-1 on-demand list prices</strong> (captured
        2026-07). Excludes any WAF you attach yourself, data transfer, and the free tiers most
        accounts still have — so treat this as an upper bound.
      </p>

      <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
        <div>
          <h3>Inputs</h3>
          {num("subscribers", "Recipients per send", "", 1000)}
          <div style={{ marginBottom: 10 }}>
            <span style={{ display: "block", fontSize: 13 }}>Sends per year</span>
            {preset("Once", 1)}
            {preset("Weekly", 52)}
            {preset("Daily", 365)}
            <input
              type="number"
              min={0}
              value={String(input.sendsPerYear)}
              onChange={(e) => setInput({ ...input, sendsPerYear: Number(e.target.value) })}
              style={{ width: 90, marginLeft: 8 }}
            />
          </div>
          {num("openRate", "Open rate", "0.40 = 40%", 0.05)}
          {num("clickRate", "Click rate", "0.05 = 5%", 0.01)}
          {num("bounceRate", "Bounce + complaint rate", "0.02 = 2%", 0.005)}
          {num("orgs", "Organizations", "$1/mo KMS key each")}
          {num("alarms", "CloudWatch alarms")}
          {num("secrets", "Secrets Manager secrets")}
        </div>

        <div style={{ flex: 1, minWidth: 380 }}>
          <h3>Per send — {usd(est.perSendTotalUsd)}</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            Generates <strong>{est.eventsPerSend.toLocaleString()}</strong> engagement events
            (one delivery per recipient, plus opens, clicks and bounces).
          </p>
          <table>
            <tbody>
              {est.perSend.map((l: CostLine) => (
                <tr key={l.label}>
                  <td>{l.label}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(l.usd)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{l.detail}</td>
                </tr>
              ))}
              <tr>
                <td><strong>Total per send</strong></td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  <strong>{usd(est.perSendTotalUsd)}</strong>
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {usd((est.perSendTotalUsd / Math.max(1, input.subscribers)) * 1000)} per 1,000
                </td>
              </tr>
            </tbody>
          </table>

          <h3 style={{ marginTop: 20 }}>Fixed — {usd(est.fixedMonthlyUsd)}/month</h3>
          <p className="muted" style={{ fontSize: 12 }}>Accrues whether or not you send anything.</p>
          <table>
            <tbody>
              {est.fixedMonthly.map((l: CostLine) => (
                <tr key={l.label}>
                  <td>{l.label}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{usd(l.usd)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{l.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 20 }}>Annual — {usd(est.annualUsd)}</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            {input.sendsPerYear.toLocaleString()} sends × {usd(est.perSendTotalUsd)} +{" "}
            {usd(est.fixedMonthlyUsd)}/mo × 12 + accrued event storage.
          </p>

          {/*
            The same annual figure at the cadences people actually budget in.
            All four are slices of `annualUsd`, so they always reconcile to the
            total above — a second model here could disagree with it.

            Per campaign is annual ÷ sends, NOT the per-send total: it carries
            each send's share of the fixed monthly cost, which is the number
            that answers "what does one more campaign cost me". At one send a
            year that is a whole year of fixed cost on a single campaign, which
            is correct and worth being able to see.
          */}
          <div className="kpis" style={{ marginTop: 12 }}>
            <div className="kpi">
              <div className="n num">{usd(est.annualUsd / 365)}</div>
              <div className="l">per day</div>
            </div>
            <div className="kpi">
              <div className="n num">{usd(est.annualUsd / 12)}</div>
              <div className="l">per month</div>
            </div>
            <div className="kpi">
              <div className="n num">
                {input.sendsPerYear > 0 ? usd(est.annualUsd / input.sendsPerYear) : "—"}
              </div>
              <div className="l">per campaign</div>
            </div>
            <div className="kpi">
              <div className="n num">{usd(est.annualUsd)}</div>
              <div className="l">per year</div>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Per campaign is the annual total split across{" "}
            {input.sendsPerYear.toLocaleString()} send{input.sendsPerYear === 1 ? "" : "s"}, so it
            includes each send's share of the {usd(est.fixedMonthlyUsd)}/month fixed cost —{" "}
            {usd(est.perSendTotalUsd)} of it is the send itself.
          </p>
        </div>
      </div>
    </section>
  );
}
