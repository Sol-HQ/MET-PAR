import type { LaunchChart } from "@/lib/launch";

function points(values: number[], width: number, height: number, left: number, right: number, top: number, bottom: number): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const spanCount = Math.max(values.length - 1, 1);
  return values
    .map((value, index) => {
      const x = left + (index / spanCount) * (width - left - right);
      const y = span === 0 ? top + (height - top - bottom) / 2 : top + (1 - (value - min) / span) * (height - top - bottom);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
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
}) {
  const left = 16;
  const right = 132;
  const top = 18;
  const bottom = 32;
  const line = points(values, width, height, left, right, top, bottom);
  const markX = markAt === null ? null : left + (markAt / 100) * (width - left - right);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <line x1={left} y1={top} x2={left} y2={height - bottom} />
      <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} />
      {markX !== null ? <line className="mark" x1={markX} y1={top} x2={markX} y2={height - bottom} /> : null}
      <polyline points={line} />
      {startLabel === endLabel ? (
        <text x={width - right + 10} y={top + (height - top - bottom) / 2 + 4}>
          {endLabel}
        </text>
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
      <text x={width - right} y={height - 8} textAnchor="end">
        {rightLabel}
      </text>
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
        rightLabel="Last token sold"
        startLabel={chart.openLabel}
        endLabel={chart.endLabel}
        markAt={chart.shelfAt}
        label={chart.line}
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
      />
    </section>
  );
}
