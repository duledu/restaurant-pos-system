interface LogoProps {
  variant?: "full" | "mark" | "wordmark";
  theme?: "dark" | "light";
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const SIZE_MAP = {
  sm: { mark: 24, text: 14, sub: 8 },
  md: { mark: 32, text: 18, sub: 10 },
  lg: { mark: 44, text: 24, sub: 12 },
  xl: { mark: 64, text: 32, sub: 14 },
};

function TcMark({ size, theme }: { size: number; theme: "dark" | "light" }) {
  const tableColor = theme === "dark" ? "#FFFFFF" : "#0A1931";
  const cColor = theme === "dark" ? "#B3CFE5" : "#4A7FA7";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 44 44"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Table: oval top (table surface seen from above) */}
      <ellipse cx="19" cy="12" rx="16" ry="6.5" fill={tableColor} />
      {/* Table: stem / leg */}
      <rect x="16" y="17.5" width="6" height="19" rx="3" fill={tableColor} />
      {/* Table: base foot */}
      <ellipse cx="19" cy="38" rx="9.5" ry="4" fill={tableColor} opacity="0.85" />
      {/* C bracket — opens left, arc on the right */}
      <path
        d="M33 8 C43 8, 47 16, 44 24 C41 32, 34 40, 27 38"
        stroke={cColor}
        strokeWidth="5.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TableCoreLogo({ variant = "full", theme = "light", size = "md", className = "" }: LogoProps) {
  const { mark, text, sub } = SIZE_MAP[size];
  const tableText = theme === "dark" ? "#FFFFFF" : "#0A1931";
  const coreText = theme === "dark" ? "#B3CFE5" : "#4A7FA7";
  const subText = theme === "dark" ? "rgba(179,207,229,0.65)" : "rgba(74,127,167,0.7)";

  if (variant === "mark") {
    return (
      <span className={`inline-flex shrink-0 ${className}`}>
        <TcMark size={mark} theme={theme} />
      </span>
    );
  }

  if (variant === "wordmark") {
    return (
      <span className={`inline-flex items-baseline ${className}`} aria-label="TableCore">
        <span style={{ color: tableText, fontSize: text, fontWeight: 700, letterSpacing: "-0.02em" }}>Table</span>
        <span style={{ color: coreText, fontSize: text, fontWeight: 700, letterSpacing: "-0.02em" }}>Core</span>
      </span>
    );
  }

  return (
    <div className={`flex items-center gap-2.5 ${className}`} aria-label="TableCore Restaurant Control System">
      <TcMark size={mark} theme={theme} />
      <div className="flex flex-col leading-none">
        <span style={{ fontSize: text, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
          <span style={{ color: tableText }}>Table</span>
          <span style={{ color: coreText }}>Core</span>
        </span>
        {size !== "sm" && (
          <span
            style={{ fontSize: sub, color: subText, letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 3, fontWeight: 500 }}
          >
            Restaurant Control System
          </span>
        )}
      </div>
    </div>
  );
}
