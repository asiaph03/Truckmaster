import { IsDateString } from 'class-validator';

/** UI_UX_DESIGN.md §5.4.3 Decision DB-C-4 — Calendar drag-to-reschedule. */
export class RescheduleStopDto {
  @IsDateString()
  appointmentDatetime!: string;
}
