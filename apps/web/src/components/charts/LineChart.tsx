"use client";

// Hand-rolled single-series SVG line chart (P2-E) — no chart library.
// Dataviz method compliance:
//  - 2px round-joined series line, >=8px round markers with a 2px
//    surface ring (small point counts, <=30);
//  - recessive lavender hairline grid, no y-axis spine;
//  - selective direct labels (first / last / max only), text in text
//    tokens, tabular numerals;
//  - crosshair + tooltip: the WHOLE plot is the hit area and the pointer
//    snaps to the nearest point's X (nobody aims at a 2px line); same
//    readout on keyboard focus + arrow keys;
//  - danger dates render as coral DIAMONDS (distinct shape, not color
//    alone) — the parent renders the matching labeled legend entry;
//  - `mini` variant (Home sparkline): line + endpoint dot only, no axes,
//    no grid, no interaction.
// Tooltips enhance, never gate: the parent renders a "View as list"
// table with every value (ChartTable).

import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import styles from "./charts.module.css";
import { useContainerWidth } from "./useContainerWidth";
import type { SeriesPoint } from "@/lib/types";

const DAY_MS = 24 * 3600 * 1000;

interface LineChartProps {
  /** Date-ascending, one point per day (the API guarantees both). */
  points: SeriesPoint[];
  yDomain: [number, number];
  /** Horizontal hairline positions + left tick labels (full variant). */
  yTicks?: number[];
  /** X-domain spans the last `windowDays` days ending today (UTC). */
  windowDays?: number;
  /** Dates flagged with danger signs — drawn as coral diamonds. */
  markedDates?: string[];
  formatValue?: (v: number) => string;
  ariaLabel: string;
  height?: number;
  mini?: boolean;
}

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function formatShortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

export default function LineChart({
  points,
  yDomain,
  yTicks = [],
  windowDays,
  markedDates = [],
  formatValue = (v) => String(v),
  ariaLabel,
  height = 190,
  mini = false,
}: LineChartProps) {
  const [wrapRef, width] = useContainerWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  // Never render a broken 1-point "line" — parents show a designed empty
  // state instead, this guard is defense in depth.
  if (points.length < 2) return null;

  const m = mini
    ? { top: 6, right: 6, bottom: 6, left: 6 }
    : { top: 18, right: 14, bottom: 22, left: 30 };
  const innerW = Math.max(width - m.left - m.right, 0);
  const innerH = height - m.top - m.bottom;

  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;
  const todayUtc = new Date().toISOString().slice(0, 10);
  const domainEnd = windowDays ? Math.max(dateMs(todayUtc), dateMs(lastPoint.date)) : dateMs(lastPoint.date);
  const domainStart = windowDays
    ? Math.min(domainEnd - (windowDays - 1) * DAY_MS, dateMs(firstPoint.date))
    : dateMs(firstPoint.date);
  const domainSpan = Math.max(domainEnd - domainStart, 1);

  const [y0, y1] = yDomain;
  const x = (date: string) => m.left + ((dateMs(date) - domainStart) / domainSpan) * innerW;
  const y = (v: number) => m.top + (1 - (v - y0) / (y1 - y0)) * innerH;

  const coords = points.map((p) => ({ ...p, px: x(p.date), py: y(p.value) }));
  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.px.toFixed(1)} ${c.py.toFixed(1)}`).join(" ");

  const marked = new Set(markedDates);

  // Selective direct labels: first, last, and the maximum — never every point.
  let maxIdx = 0;
  points.forEach((p, i) => {
    if (p.value > (points[maxIdx]?.value ?? -Infinity)) maxIdx = i;
  });
  const labelIdxs = new Set([0, points.length - 1, maxIdx]);

  function nearestIndex(clientX: number, el: SVGSVGElement): number {
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0;
    let bestDist = Infinity;
    coords.forEach((c, i) => {
      const d = Math.abs(c.px - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    setActive(nearestIndex(e.clientX, e.currentTarget));
  }

  // Touch fires pointerleave right after touchend — clearing there would
  // dismiss the tooltip the tap just opened (and the follow-up focus
  // event would then snap it to the LAST point). Only mouse pointers
  // clear on leave; touch tooltips persist until blur (tap elsewhere).
  function onPointerLeave(e: PointerEvent<SVGSVGElement>) {
    if (e.pointerType === "mouse") setActive(null);
  }

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setActive((prev) => {
        const base = prev ?? points.length - 1;
        const next = e.key === "ArrowRight" ? base + 1 : base - 1;
        return Math.min(Math.max(next, 0), points.length - 1);
      });
    } else if (e.key === "Escape") {
      setActive(null);
    }
  }

  const activePoint = active != null ? coords[active] : undefined;
  const tooltipStyle: CSSProperties | undefined = activePoint
    ? {
        left: Math.min(Math.max(activePoint.px, 8), Math.max(width - 8, 8)),
        top: Math.max(activePoint.py - 12, 0),
        transform: `translate(${
          activePoint.px < 80 ? "0" : activePoint.px > width - 80 ? "-100%" : "-50%"
        }, -100%)`,
      }
    : undefined;

  const interactive = !mini;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      {width > 0 && (
        <svg
          className={styles.svg}
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          tabIndex={interactive ? 0 : undefined}
          onPointerMove={interactive ? onPointerMove : undefined}
          onPointerDown={interactive ? onPointerMove : undefined}
          onPointerLeave={interactive ? onPointerLeave : undefined}
          onKeyDown={interactive ? onKeyDown : undefined}
          onFocus={interactive ? () => setActive((p) => p ?? points.length - 1) : undefined}
          onBlur={interactive ? () => setActive(null) : undefined}
        >
          {/* Recessive horizontal hairlines + left tick labels; no axis spine. */}
          {!mini &&
            yTicks.map((t) => (
              <g key={t}>
                <line className={styles.gridLine} x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} />
                <text className={styles.tickLabel} x={m.left - 6} y={y(t) + 3.5} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}

          {/* X-axis: just the window's endpoints — the tooltip + table carry the rest. */}
          {!mini && (
            <>
              <text className={styles.axisLabel} x={m.left} y={height - 6} textAnchor="start">
                {formatShortDate(new Date(domainStart).toISOString().slice(0, 10))}
              </text>
              <text className={styles.axisLabel} x={width - m.right} y={height - 6} textAnchor="end">
                {formatShortDate(new Date(domainEnd).toISOString().slice(0, 10))}
              </text>
            </>
          )}

          {/* Crosshair finds the X (behind marks). */}
          {interactive && activePoint && (
            <line
              className={styles.crosshair}
              x1={activePoint.px}
              x2={activePoint.px}
              y1={m.top}
              y2={m.top + innerH}
            />
          )}

          <path className={styles.seriesLine} d={path} />

          {/* Markers: every point in the full variant (small counts), endpoint
              only in mini. Danger dates get a coral diamond INSTEAD of the
              purple dot — distinct shape and hue. */}
          {coords.map((c, i) => {
            if (mini && i !== coords.length - 1) return null;
            if (marked.has(c.date)) {
              return (
                <rect
                  key={c.date}
                  className={styles.dangerMarker}
                  x={c.px - 4.5}
                  y={c.py - 4.5}
                  width={9}
                  height={9}
                  rx={1.5}
                  transform={`rotate(45 ${c.px} ${c.py})`}
                />
              );
            }
            return (
              <circle
                key={c.date}
                className={styles.marker}
                cx={c.px}
                cy={c.py}
                r={active === i ? 5 : 4}
              />
            );
          })}

          {/* Selective direct labels: first / last / max. */}
          {!mini &&
            coords.map((c, i) => {
              if (!labelIdxs.has(i)) return null;
              // Labels ride ABOVE the marker whenever the text still fits
              // inside the SVG — the top margin exists for exactly this.
              // Only a point hugging the very top edge pushes its label
              // below (baseline at py-9, ~11px cap height above it).
              const above = c.py - 20 >= 0;
              const anchor = c.px < m.left + 22 ? "start" : c.px > width - m.right - 22 ? "end" : "middle";
              return (
                <text
                  key={`label-${c.date}`}
                  className={styles.pointLabel}
                  x={c.px}
                  y={above ? c.py - 9 : c.py + 17}
                  textAnchor={anchor}
                >
                  {formatValue(c.value)}
                </text>
              );
            })}
        </svg>
      )}

      {interactive && activePoint && (
        <div className={styles.tooltip} style={tooltipStyle} role="status">
          <div className={styles.tooltipValue}>
            <span className={styles.tooltipKey} aria-hidden="true" />
            {formatValue(activePoint.value)}
          </div>
          <div className={styles.tooltipDate}>{formatShortDate(activePoint.date)}</div>
          {marked.has(activePoint.date) && (
            <div className={styles.tooltipDanger}>
              <span className={styles.legendDiamond} aria-hidden="true" />
              Danger signs noted
            </div>
          )}
        </div>
      )}
    </div>
  );
}
