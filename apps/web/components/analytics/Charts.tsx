"use client";

/**
 * Faza 7 — tanki recharts wrapperi. Renderuju ISKLJUČIVO već izračunate
 * podatke sa servera (analytics-service.ts) — nema finansijske matematike
 * ovde, samo prikaz (zahtev #19 — "UI renders results").
 */

import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

const COLOR_CURRENT = "#4A7FA7"; // gold (brend akcenat)
const COLOR_PREVIOUS = "#B3CFE5"; // cream-300, svetlije/neutralno za prethodni period
const COLOR_GRID = "#C8DDEF"; // line
const COLOR_TEXT = "#1A4A73"; // inkSoft
const DONUT_COLORS = ["#4A7FA7", "#1A3D63", "#B45309", "#15803D", "#B91C1C"];

function money(value: number, currency: string): string {
  return `${value.toLocaleString("sr-RS", { maximumFractionDigits: 0 })} ${currency}`;
}

const axisStyle = { fontSize: 11, fill: COLOR_TEXT };

interface TooltipEntry {
  name: string;
  value: number;
  color: string;
}

function ChartTooltip({ active, payload, label, currency }: { active?: boolean; payload?: TooltipEntry[]; label?: string; currency: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-line bg-white px-3 py-2 text-xs shadow-elevated">
      <p className="mb-1 font-medium text-ink">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>
          {p.name}: {money(p.value, currency)}
        </p>
      ))}
    </div>
  );
}

// ── TREND (linijski, tekući + opciono prethodni period) ─────────────────

export interface TrendChartPoint {
  label: string;
  current: number;
  previous?: number;
}

export function TrendLineChart({ data, currency }: { data: TrendChartPoint[]; currency: string }) {
  if (data.length === 0) return null;
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={COLOR_GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: COLOR_GRID }} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
        <Tooltip content={<ChartTooltip currency={currency} />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="current" name="Tekući period" stroke={COLOR_CURRENT} strokeWidth={2.5} dot={false} />
        {data.some((d) => d.previous !== undefined) && (
          <Line type="monotone" dataKey="previous" name="Prethodni period" stroke={COLOR_PREVIOUS} strokeWidth={2} strokeDasharray="4 4" dot={false} />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── SATI / DANI U NEDELJI (stubičasti) ────────────────────────────────────

export interface BarChartDatum {
  label: string;
  value: number;
  highlight?: boolean;
}

export function SalesBarChart({ data, currency, valueLabel = "Prodaja" }: { data: BarChartDatum[]; currency: string; valueLabel?: string }) {
  if (data.length === 0) return null;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={COLOR_GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: COLOR_GRID }} interval="preserveStartEnd" />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
        <Tooltip content={<ChartTooltip currency={currency} />} />
        <Bar dataKey="value" name={valueLabel} radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.highlight ? "#1A3D63" : COLOR_CURRENT} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── KUHINJA / ŠANK (poređenje, dva stuba) ─────────────────────────────────

export interface StationChartDatum {
  label: string;
  revenue: number;
  voidValue: number;
}

export function StationBarChart({ data, currency }: { data: StationChartDatum[]; currency: string }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
        <CartesianGrid stroke={COLOR_GRID} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={axisStyle} tickLine={false} axisLine={{ stroke: COLOR_GRID }} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
        <YAxis type="category" dataKey="label" tick={{ ...axisStyle, fontSize: 13 }} tickLine={false} axisLine={false} width={70} />
        <Tooltip content={<ChartTooltip currency={currency} />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="revenue" name="Promet" fill={COLOR_CURRENT} radius={[0, 4, 4, 0]} />
        <Bar dataKey="voidValue" name="Storno" fill="#B91C1C" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── NAČINI PLAĆANJA (donut — malo kategorija, prihvatljivo po zahtevu #13) ─

export interface DonutDatum {
  label: string;
  value: number;
}

export function PaymentDonutChart({ data, currency }: { data: DonutDatum[]; currency: string }) {
  if (data.length === 0) return null;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="label" innerRadius={55} outerRadius={85} paddingAngle={2}>
          {data.map((_, i) => (
            <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip content={<ChartTooltip currency={currency} />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
