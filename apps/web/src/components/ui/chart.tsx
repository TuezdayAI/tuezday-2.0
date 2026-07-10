"use client";
// apps/web/src/components/ui/chart.tsx — spec §6.4.
// Recharts locked to Editorial: tone palette, hairline axes, Inter labels,
// paper background, no gradients/3D. Consult the dataviz skill when extending.
import { useEffect, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import styles from "./chart.module.css";

type ToneIndex = 1 | 2 | 3 | 4 | 5 | 6;

export interface ChartSeries {
  key: string;
  label: string;
  tone?: ToneIndex;
}

/** SVG attributes can't resolve CSS var(); read computed tone colors once. */
function useToneColors(): Record<ToneIndex, string> | null {
  const [colors, setColors] = useState<Record<ToneIndex, string> | null>(null);
  useEffect(() => {
    const cs = getComputedStyle(document.documentElement);
    setColors({
      1: cs.getPropertyValue("--c1-deep").trim(),
      2: cs.getPropertyValue("--c2-deep").trim(),
      3: cs.getPropertyValue("--c3-deep").trim(),
      4: cs.getPropertyValue("--c4-deep").trim(),
      5: cs.getPropertyValue("--c5-deep").trim(),
      6: cs.getPropertyValue("--c6-deep").trim(),
    });
  }, []);
  return colors;
}

const AXIS = { fontSize: 11, fontFamily: "var(--font-body)" } as const;

function toneOf(tones: Record<ToneIndex, string>, s: ChartSeries, i: number): string {
  return tones[s.tone ?? (((i % 6) + 1) as ToneIndex)];
}

/** Plain-DOM legend so multi-series identity is never color-alone (dataviz: legend for two or more series). */
function SeriesLegend({ series, tones }: { series: ChartSeries[]; tones: Record<ToneIndex, string> }) {
  if (series.length < 2) return null;
  return (
    <ul className={styles.legend}>
      {series.map((s, i) => (
        <li key={s.key} className={styles.legendItem}>
          <span className={styles.swatch} style={{ background: toneOf(tones, s, i) }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

interface ChartProps {
  data: Array<Record<string, string | number>>;
  xKey: string;
  series: ChartSeries[];
  height?: number;
}

export function TrendChart({ data, xKey, series, height = 220 }: ChartProps) {
  const tones = useToneColors();
  if (!tones) return <div className={styles.placeholder} style={{ height }} />;
  return (
    <div className={styles.frame}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="0" stroke={tones[5]} strokeOpacity={0.12} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} axisLine={{ strokeOpacity: 0.25 }} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} width={44} />
          <Tooltip wrapperClassName={styles.tooltip} />
          {series.map((s, i) => (
            <Line
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stroke={toneOf(tones, s, i)}
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <SeriesLegend series={series} tones={tones} />
    </div>
  );
}

export function CompareChart({ data, xKey, series, height = 220 }: ChartProps) {
  const tones = useToneColors();
  if (!tones) return <div className={styles.placeholder} style={{ height }} />;
  return (
    <div className={styles.frame}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="0" stroke={tones[5]} strokeOpacity={0.12} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} axisLine={{ strokeOpacity: 0.25 }} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} width={44} />
          <Tooltip wrapperClassName={styles.tooltip} cursor={{ fillOpacity: 0.06 }} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              fill={toneOf(tones, s, i)}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <SeriesLegend series={series} tones={tones} />
    </div>
  );
}

interface SparklineProps {
  data: Array<Record<string, string | number>>;
  dataKey: string;
  tone?: ToneIndex;
  height?: number;
}

export function Sparkline({ data, dataKey, tone = 5, height = 36 }: SparklineProps) {
  const tones = useToneColors();
  if (!tones) return <div className={styles.placeholder} style={{ height }} />;
  return (
    <ResponsiveContainer width="100%" height={height} className={styles.spark}>
      <LineChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
        <Line dataKey={dataKey} stroke={tones[tone]} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
