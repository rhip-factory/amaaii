"use client";

// Hand-rolled horizontal bar chart (P2-E) — top-N symptom counts.
// Dataviz method compliance:
//  - magnitude job: ONE hue for every bar (identity lives in the row
//    labels, never a rainbow / value-ramp);
//  - bars 18px thick (<=24), 4px rounded at the DATA end, square at the
//    baseline; rows are spaced so no marks touch;
//  - values direct-labeled at every bar tip (few bars), so no gridlines
//    and no axis — the label + the table view carry the numbers;
//  - each row's full band is the hit target (>=34px tall), hovered bar
//    lifts one step lighter, tooltip on hover/tap/focus.

import { useState, type CSSProperties } from "react";
import styles from "./charts.module.css";
import { useContainerWidth } from "./useContainerWidth";
import type { SymptomCount } from "@/lib/types";

const ROW_H = 34;
const BAR_H = 18;
const END_RADIUS = 4;
const VALUE_GUTTER = 30; // room for the count label at the tip

interface BarChartProps {
  bars: SymptomCount[];
  ariaLabel: string;
  /** Tooltip unit, e.g. "check-in(s)". */
  unit?: string;
}

// Square at the baseline (left), 4px-rounded at the data end (right).
function barPath(x: number, yTop: number, w: number, h: number): string {
  const r = Math.min(END_RADIUS, w, h / 2);
  return [
    `M${x} ${yTop}`,
    `h${w - r}`,
    `a${r} ${r} 0 0 1 ${r} ${r}`,
    `v${h - 2 * r}`,
    `a${r} ${r} 0 0 1 -${r} ${r}`,
    `h-${w - r}`,
    "z",
  ].join(" ");
}

export default function BarChart({ bars, ariaLabel, unit = "check-in" }: BarChartProps) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  if (bars.length === 0) return null;

  const height = bars.length * ROW_H;
  const maxLabel = Math.max(...bars.map((b) => b.symptom.length));
  const gutter = Math.min(130, Math.max(66, maxLabel * 7.4 + 10));
  const barArea = Math.max(width - gutter - VALUE_GUTTER, 0);
  const maxCount = Math.max(...bars.map((b) => b.count));

  const activeBar = active != null ? bars[active] : undefined;
  const tooltipStyle: CSSProperties | undefined =
    active != null && activeBar
      ? {
          left: Math.min(gutter + (activeBar.count / maxCount) * barArea + 8, Math.max(width - 8, 8)),
          top: active * ROW_H + ROW_H / 2,
          transform: `translate(${
            gutter + (activeBar.count / maxCount) * barArea > width - 120 ? "-100%" : "0"
          }, -50%)`,
        }
      : undefined;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      {width > 0 && (
        <svg className={styles.svg} width={width} height={height} role="img" aria-label={ariaLabel}>
          {bars.map((b, i) => {
            const yTop = i * ROW_H + (ROW_H - BAR_H) / 2;
            const w = Math.max((b.count / maxCount) * barArea, 3);
            return (
              <g key={b.symptom}>
                <path
                  className={active === i ? styles.barActive : styles.bar}
                  d={barPath(gutter, yTop, w, BAR_H)}
                />
                <text
                  className={styles.barLabel}
                  x={gutter - 8}
                  y={yTop + BAR_H / 2 + 4}
                  textAnchor="end"
                >
                  {b.symptom}
                </text>
                <text
                  className={styles.barValue}
                  x={gutter + w + 6}
                  y={yTop + BAR_H / 2 + 4}
                  textAnchor="start"
                >
                  {b.count}
                </text>
                {/* Full-band hit target (>= 34px tall), keyboard-focusable. */}
                <rect
                  className={styles.barHit}
                  x={0}
                  y={i * ROW_H}
                  width={width}
                  height={ROW_H}
                  tabIndex={0}
                  aria-label={`${b.symptom}: ${b.count} ${unit}${b.count === 1 ? "" : "s"}`}
                  onPointerEnter={() => setActive(i)}
                  onPointerDown={() => setActive(i)}
                  // Touch fires pointerleave right after touchend — only mouse
                  // clears on leave (the focus that follows a tap keeps the bar
                  // active; blur clears it).
                  onPointerLeave={(e) => {
                    if (e.pointerType === "mouse") setActive(null);
                  }}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                />
              </g>
            );
          })}
        </svg>
      )}

      {activeBar && (
        <div className={styles.tooltip} style={tooltipStyle} role="status">
          <div className={styles.tooltipValue}>
            {activeBar.count} {unit}
            {activeBar.count === 1 ? "" : "s"}
          </div>
          <div className={styles.tooltipDate}>{activeBar.symptom}</div>
        </div>
      )}
    </div>
  );
}
