import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { Badge } from '../components/ui';
import {
  formatBusinessDateTime,
  formatBusinessTime,
  getBusinessTimeZoneAbbreviation,
} from '../routes/loads/businessTimezone';
import './EasternClock.css';

/**
 * Header live clock — always shows the business timezone
 * (`America/New_York`, per commit e79c803's centralized Eastern-time
 * fix), never the viewing browser's or server's own local timezone.
 * Ticks every second so it never needs a page refresh; EST/EDT is
 * re-derived from `Intl`/ICU on every tick rather than cached, so it
 * flips automatically the instant a DST boundary is crossed.
 */
export function EasternClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const iso = now.toISOString();
  const time = formatBusinessTime(iso);
  const date = formatBusinessDateTime(iso, { month: 'short', day: 'numeric', year: 'numeric' });
  const zoneAbbreviation = getBusinessTimeZoneAbbreviation(now);

  return (
    <div
      className="eastern-clock"
      aria-label={`Eastern Time: ${time} ${zoneAbbreviation}, ${date}`}
    >
      <Clock size={16} strokeWidth={1.5} className="eastern-clock-icon" aria-hidden="true" />
      <div className="eastern-clock-text">
        <div className="eastern-clock-time tabular-nums">
          <span>{time}</span>
          <Badge label={zoneAbbreviation} color="neutral" />
        </div>
        <div className="eastern-clock-date">{date}</div>
      </div>
    </div>
  );
}
