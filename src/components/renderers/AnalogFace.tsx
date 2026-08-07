interface AnalogFaceProps {
  /** 0-23 (or 1-12 under a 12-hour display) — only hour % 12 affects the hand. */
  hour: number;
  minute: number;
}

const BATON_ANGLES = Array.from({ length: 12 }, (_, i) => i * 30);

/**
 * A plain analog wall-clock face: 12 unmarked batons, hour and minute
 * hands, no numerals, no second hand. Deliberately generic railway-clock
 * styling, not a reproduction of any specific trademarked design.
 */
export default function AnalogFace({ hour, minute }: AnalogFaceProps) {
  const hourAngle = ((hour % 12) + minute / 60) * 30;
  const minuteAngle = minute * 6;

  return (
    <svg className="analog-face" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="48" fill="#fff" stroke="#1a1a1a" strokeWidth="2" />
      {BATON_ANGLES.map((angle) => (
        <rect
          key={angle}
          x="48.5"
          y="4"
          width="3"
          height="10"
          rx="1"
          fill="#1a1a1a"
          transform={`rotate(${angle} 50 50)`}
        />
      ))}
      <rect
        className="analog-hand-hour"
        x="48"
        y="22"
        width="4"
        height="28"
        rx="2"
        fill="#1a1a1a"
        transform={`rotate(${hourAngle} 50 50)`}
      />
      <rect
        className="analog-hand-minute"
        x="48.75"
        y="10"
        width="2.5"
        height="40"
        rx="1.25"
        fill="#1a1a1a"
        transform={`rotate(${minuteAngle} 50 50)`}
      />
      <circle cx="50" cy="50" r="3" fill="#1a1a1a" />
    </svg>
  );
}
