// Classic JSX in the CLI build needs React in scope.
import React from "react";
import { getScoreGrade, getScoreInkColor, SCORE_INK_COLORS } from "../../../scoring";

/**
 * A score ring with its number and grade, colored by score band (red to green)
 * in the band's ink tone, readable on the white cards it sits on. A group's own
 * color belongs on its card border and badge, never on the score.
 */
export function ScoreCircle({ score, size = 64 }: { score: number | null; size?: number }) {
  const strokeWidth = 7;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedScore = Math.max(0, Math.min(100, score ?? 0));
  const offset = circumference - (clampedScore / 100) * circumference;
  const color = score === null ? SCORE_INK_COLORS.none : getScoreInkColor(clampedScore);
  const grade = score === null ? "-" : getScoreGrade(clampedScore);

  return (
    <div className="inline-flex flex-col items-center gap-1">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={score === null ? "No score" : `Score: ${clampedScore} out of 100`}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(148, 163, 184, 0.35)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="48%"
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fill: color, fontSize: size * 0.24, fontWeight: 700 }}
        >
          {score === null ? "-" : `${clampedScore}`}
        </text>
        <text
          x="50%"
          y="68%"
          textAnchor="middle"
          dominantBaseline="middle"
          style={{ fill: color, fontSize: size * 0.18, fontWeight: 600 }}
        >
          {grade}
        </text>
      </svg>
    </div>
  );
}
