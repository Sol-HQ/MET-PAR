import type { LaunchChart } from "@/lib/launch";

function placed(values: number[], width: number, height: number, left: number, right: number, top: number, bottom: number): { x: number; y: number }[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const spanCount = Math.max(values.length - 1, 1);
  return values.map((value, index) => ({
    x: left + (index / spanCount) * (width - left - right),
    y: span === 0 ? top + (height - top - bottom) / 2 : top + (1 - (value - min) / span) * (height - top - bottom),
  }));
}

function Plot({
  values,
  width,
  height,
  leftLabel,
  rightLabel,
  startLabel,
  endLabel,
  markAt,
  label,
  poolMark,
  aside,
}: {
  values: number[];
  width: number;
  height: number;
  leftLabel: string;
  rightLabel: string;
  startLabel: string;
  endLabel: string;
  markAt: number | null;
  label: string;
  poolMark: boolean;
  aside?: string;
}) {
  const left = 16;
  const right = 148;
  const top = 28;
  const bottom = 32;
  const spots = placed(values, width, height, left, right, top, bottom);
  const line = spots.map((spot) => `${spot.x.toFixed(1)},${spot.y.toFixed(1)}`).join(" ");
  const last = spots[spots.length - 1];
  const first = spots[0];
  const markX = markAt === null ? null : left + (markAt / 100) * (width - left - right);
  const flat = startLabel === endLabel;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <line x1={left} y1={top} x2={left} y2={height - bottom} />
      <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} />
      {markX !== null ? <line className="mark" x1={markX} y1={top} x2={markX} y2={height - bottom} /> : null}
      {poolMark ? (
        <>
          <line className="pool" x1={left} y1={last.y} x2={last.x} y2={last.y} />
          <line className="graduation" x1={last.x} y1={top} x2={last.x} y2={height - bottom} />
        </>
      ) : null}
      <polyline points={line} />
      {flat ? (
        <text x={width - right + 10} y={last.y + 4}>
          {endLabel}
        </text>
      ) : poolMark ? (
        <>
          <text className="pool" x={width - right + 10} y={Math.max(top - 8, last.y - 6)}>
            Pool price
          </text>
          <text className="pool" x={width - right + 10} y={Math.max(top + 6, last.y + 8)}>
            {endLabel}
          </text>
          <text x={width - right + 10} y={first.y + 4}>
            {startLabel}
          </text>
        </>
      ) : (
        <>
          <text x={width - right + 10} y={top + 4}>
            {endLabel}
          </text>
          <text x={width - right + 10} y={height - bottom}>
            {startLabel}
          </text>
        </>
      )}
      <text x={left} y={height - 8}>
        {leftLabel}
      </text>
      <text className={poolMark ? "graduation" : undefined} x={poolMark ? last.x - 4 : width - right} y={height - 8} textAnchor="end">
        {rightLabel}
      </text>
      {aside ? (
        <text className="graduation" x={width - right + 10} y={height - 8}>
          {aside}
        </text>
      ) : null}
    </svg>
  );
}

export function CurveSketch({ chart }: { chart: LaunchChart | null }) {
  if (!chart) {
    return (
      <section className="curve-sketch">
        <h2>The curve on this card</h2>
        <p>These numbers do not draw a curve yet.</p>
      </section>
    );
  }
  return (
    <section className="curve-sketch">
      <h2>The curve on this card</h2>
      <p>{chart.line}</p>
      <Plot
        values={chart.prices}
        width={640}
        height={220}
        leftLabel="First token"
        rightLabel="Graduation"
        startLabel={chart.openLabel}
        endLabel={chart.endLabel}
        markAt={chart.shelfAt}
        label={chart.line}
        poolMark
        aside={chart.graduationLabel}
      />
      <h3>The fee clock</h3>
      <p>{chart.feeLine}</p>
      <Plot
        values={chart.feePercents}
        width={640}
        height={160}
        leftLabel="Open"
        rightLabel={chart.feePercents[0] === chart.feePercents[chart.feePercents.length - 1] ? "Until migration" : "Clock ends"}
        startLabel={`${chart.feePercents[chart.feePercents.length - 1]}%`}
        endLabel={`${chart.feePercents[0]}%`}
        markAt={null}
        label={chart.feeLine}
        poolMark={false}
      />
    </section>
  );
}
