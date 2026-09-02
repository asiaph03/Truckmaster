import { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { loadsApi, type LoadSummary, type Stop } from '../../api';
import { ApiError } from '../../api/errors';
import { Badge, Button, DatePicker, Modal, ModalFooter, RowActionsMenu } from '../../components/ui';
import { useToast } from '../../components/ui/toastStore';
import { formatBusinessTime, toBusinessDatetimeLocalValue } from './businessTimezone';
import './CalendarBoard.css';

type CalendarViewMode = 'day' | 'week';

interface StopEvent {
  load: LoadSummary;
  stop: Stop;
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDayHeader(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Combines a target day's date with an existing appointment's
 * time-of-day. NOTE: still uses browser-local getters/`toISOString()`
 * for the day-only drag-to-reschedule interaction — a known, separate
 * gap from the exact-time Reschedule modal below (which now goes
 * through the Eastern-explicit conversion utilities), left untouched as
 * out of scope for this fix.
 */
function combineDayAndTime(day: Date, existingIso: string): string {
  const existingTime = new Date(existingIso);
  const combined = new Date(day);
  combined.setHours(existingTime.getHours(), existingTime.getMinutes(), 0, 0);
  return combined.toISOString();
}

/**
 * UI_UX_DESIGN.md §5.4.3 — Dispatch Board Calendar view. Events are
 * Stop-level (one entry per Stop with `appointmentDatetime` set), not
 * Load-level — a Load with 2 pickups + 1 delivery renders 3 entries
 * (Decision DB-C-1). Stops with no `appointmentDatetime` render in the
 * "Unscheduled Stops" panel instead of being omitted (DB-C-3). No
 * financial figures on events, matching Kanban's own density decision.
 *
 * Drag-to-reschedule (DB-C-4) updates `Stop.appointmentDatetime` only —
 * dragging an event onto a different day column keeps its existing
 * time-of-day and changes only the date, since this view has no
 * hour-level grid to drop onto a precise time. The keyboard-accessible
 * "Reschedule" alternative (INT-13) opens a modal with an exact
 * date+time picker, covering both the coarse (day-only) drag path and
 * precise rescheduling in one place. Only a still-PENDING stop on a
 * Load that hasn't reached DELIVERED/CLOSED is offered either
 * interaction — the server re-validates both restrictions regardless
 * (`DispatchTrackingService.rescheduleStop`).
 */
export function CalendarBoard({
  loads,
  canManage,
  onCardClick,
  onChanged,
}: {
  loads: LoadSummary[];
  canManage: boolean;
  onCardClick: (load: LoadSummary) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [viewMode, setViewMode] = useState<CalendarViewMode>('week');
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const [draggedEvent, setDraggedEvent] = useState<StopEvent | null>(null);
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const [reschedulingEvent, setReschedulingEvent] = useState<StopEvent | null>(null);
  const [rescheduleValue, setRescheduleValue] = useState('');
  const [rescheduling, setRescheduling] = useState(false);

  const visibleDays = useMemo(() => {
    if (viewMode === 'day')
      return [new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate())];
    const start = startOfWeek(anchorDate);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [anchorDate, viewMode]);

  const { scheduled, unscheduled } = useMemo(() => {
    const scheduledEvents: StopEvent[] = [];
    const unscheduledEvents: StopEvent[] = [];
    for (const load of loads) {
      for (const stop of load.stops) {
        if (stop.appointmentDatetime) scheduledEvents.push({ load, stop });
        else unscheduledEvents.push({ load, stop });
      }
    }
    scheduledEvents.sort(
      (a, b) =>
        new Date(a.stop.appointmentDatetime!).getTime() -
        new Date(b.stop.appointmentDatetime!).getTime(),
    );
    return { scheduled: scheduledEvents, unscheduled: unscheduledEvents };
  }, [loads]);

  function eventsForDay(day: Date): StopEvent[] {
    return scheduled.filter((e) => sameDay(new Date(e.stop.appointmentDatetime!), day));
  }

  function isReschedulable(event: StopEvent): boolean {
    return (
      canManage &&
      event.stop.status === 'PENDING' &&
      event.load.status !== 'DELIVERED' &&
      event.load.status !== 'CLOSED'
    );
  }

  async function reschedule(event: StopEvent, appointmentDatetime: string) {
    try {
      await loadsApi.rescheduleStop(event.load.id, event.stop.sequence, { appointmentDatetime });
      toast.success('Stop rescheduled.');
      onChanged();
    } catch (error) {
      toast.danger(error instanceof ApiError ? error.message : 'Something went wrong.');
    }
  }

  async function handleRescheduleSubmit() {
    if (!reschedulingEvent || !rescheduleValue) return;
    setRescheduling(true);
    try {
      // Sends the raw datetime-local (Eastern wall-clock, no timezone
      // marker) value as-is — the backend explicitly interprets it as
      // America/New_York (RescheduleStopDto -> parseBusinessDateTime),
      // so it must not be pre-converted to UTC via the browser's own
      // local timezone here.
      await reschedule(reschedulingEvent, rescheduleValue);
      setReschedulingEvent(null);
    } finally {
      setRescheduling(false);
    }
  }

  return (
    <div>
      <div className="calendar-nav">
        <div className="calendar-nav-controls">
          <button
            type="button"
            className="calendar-nav-arrow"
            onClick={() => setAnchorDate((d) => addDays(d, viewMode === 'day' ? -1 : -7))}
            aria-label="Previous"
          >
            <ChevronLeft size={16} strokeWidth={1.5} />
          </button>
          <Button variant="secondary" size="sm" onClick={() => setAnchorDate(new Date())}>
            Today
          </Button>
          <button
            type="button"
            className="calendar-nav-arrow"
            onClick={() => setAnchorDate((d) => addDays(d, viewMode === 'day' ? 1 : 7))}
            aria-label="Next"
          >
            <ChevronRight size={16} strokeWidth={1.5} />
          </button>
          <span className="calendar-nav-range">
            {viewMode === 'day'
              ? formatDayHeader(visibleDays[0])
              : `${formatDayHeader(visibleDays[0])} – ${formatDayHeader(visibleDays[6])}`}
          </span>
        </div>
        <div className="dispatch-board-view-switch">
          <button
            type="button"
            className={viewMode === 'day' ? 'active' : ''}
            onClick={() => setViewMode('day')}
          >
            Day
          </button>
          <button
            type="button"
            className={viewMode === 'week' ? 'active' : ''}
            onClick={() => setViewMode('week')}
          >
            Week
          </button>
        </div>
      </div>

      {scheduled.length === 0 && unscheduled.length === 0 ? (
        <div className="calendar-empty">No appointments scheduled for this period.</div>
      ) : (
        <div className={`calendar-grid calendar-grid-${viewMode}`}>
          {visibleDays.map((day) => {
            const dayKey = day.toISOString();
            const dayEvents = eventsForDay(day);
            return (
              <div
                key={dayKey}
                className={`calendar-day-column ${dragOverDay === dayKey ? 'calendar-day-column-dragover' : ''}`}
                onDragOver={(e) => {
                  if (!draggedEvent || !isReschedulable(draggedEvent)) return;
                  e.preventDefault();
                  setDragOverDay(dayKey);
                }}
                onDragLeave={() => setDragOverDay((k) => (k === dayKey ? null : k))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverDay(null);
                  const event = draggedEvent;
                  setDraggedEvent(null);
                  if (!event || !isReschedulable(event)) return;
                  reschedule(event, combineDayAndTime(day, event.stop.appointmentDatetime!));
                }}
              >
                <div className="calendar-day-header">{formatDayHeader(day)}</div>
                <div className="calendar-day-body">
                  {dayEvents.length === 0 ? (
                    <div className="calendar-day-empty">—</div>
                  ) : (
                    dayEvents.map((event) => {
                      const overdue =
                        event.stop.status === 'PENDING' &&
                        new Date(event.stop.appointmentDatetime!).getTime() < Date.now();
                      const draggable = isReschedulable(event);
                      const statusClass = overdue
                        ? 'calendar-event-danger'
                        : event.stop.status === 'ARRIVED'
                          ? 'calendar-event-brand'
                          : event.stop.status === 'COMPLETED'
                            ? 'calendar-event-success'
                            : 'calendar-event-neutral';
                      return (
                        <div
                          key={event.stop.id}
                          className={`calendar-event ${statusClass}`}
                          draggable={draggable}
                          onDragStart={() => setDraggedEvent(event)}
                          onDragEnd={() => {
                            setDraggedEvent(null);
                            setDragOverDay(null);
                          }}
                          onClick={() => onCardClick(event.load)}
                        >
                          <div className="calendar-event-top">
                            <span className="calendar-event-type">
                              {event.stop.stopType === 'PICKUP' ? (
                                <ArrowUpRight size={12} strokeWidth={1.75} />
                              ) : (
                                <ArrowDownLeft size={12} strokeWidth={1.75} />
                              )}
                              {formatBusinessTime(event.stop.appointmentDatetime!)}
                            </span>
                            {draggable ? (
                              <div onClick={(e) => e.stopPropagation()}>
                                <RowActionsMenu>
                                  <button
                                    className="data-table-row-action"
                                    onClick={() => {
                                      setRescheduleValue(
                                        toBusinessDatetimeLocalValue(
                                          event.stop.appointmentDatetime,
                                        ),
                                      );
                                      setReschedulingEvent(event);
                                    }}
                                  >
                                    Reschedule
                                  </button>
                                </RowActionsMenu>
                              </div>
                            ) : null}
                          </div>
                          <div className="calendar-event-load">{event.load.loadNumber}</div>
                          <div className="calendar-event-driver">
                            {event.load.assignedDriverName ?? 'Unassigned'}
                          </div>
                          <div className="calendar-event-location">
                            {event.stop.city}, {event.stop.state}
                          </div>
                          <div className="calendar-event-carrier">
                            {event.load.assignedCarrierId ? (
                              <Badge label="Assigned" color="neutral" />
                            ) : (
                              <Badge label="Unassigned" color="neutral" />
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="calendar-unscheduled">
        <div className="calendar-unscheduled-header">Unscheduled Stops ({unscheduled.length})</div>
        {unscheduled.length > 0 ? (
          <div className="calendar-unscheduled-list">
            {unscheduled.map((event) => (
              <div key={event.stop.id} className="calendar-unscheduled-row">
                <span className="calendar-event-type">
                  {event.stop.stopType === 'PICKUP' ? (
                    <ArrowUpRight size={12} strokeWidth={1.75} />
                  ) : (
                    <ArrowDownLeft size={12} strokeWidth={1.75} />
                  )}
                </span>
                <span>{event.load.loadNumber}</span>
                <span className="calendar-unscheduled-location">
                  {event.stop.city}, {event.stop.state}
                </span>
                {isReschedulable(event) ? (
                  <Button
                    variant="tertiary"
                    size="sm"
                    onClick={() => {
                      setRescheduleValue(toBusinessDatetimeLocalValue());
                      setReschedulingEvent(event);
                    }}
                  >
                    Schedule
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <Modal
        open={reschedulingEvent !== null}
        title="Reschedule Stop"
        onClose={() => setReschedulingEvent(null)}
        footer={
          <ModalFooter
            onCancel={() => setReschedulingEvent(null)}
            onConfirm={handleRescheduleSubmit}
            confirmLabel="Reschedule"
            loading={rescheduling}
          />
        }
      >
        <DatePicker
          label="Appointment"
          withTime
          required
          value={rescheduleValue}
          onChange={(e) => setRescheduleValue(e.target.value)}
        />
      </Modal>
    </div>
  );
}
