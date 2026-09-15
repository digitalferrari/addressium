/**
 * A single big-number tile. Shared by the Report, Usage and Import screens.
 */
export function Kpi({ n, l }: { n: number | string; l: string }) {
  return <div className="kpi"><div className="n">{n}</div><div className="l">{l}</div></div>;
}
