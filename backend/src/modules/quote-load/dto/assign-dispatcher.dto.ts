import { IsUUID, ValidateIf } from 'class-validator';

/**
 * Independent action (Workflow 4 §4.11, Workflow 5 §5.8 — approved,
 * user-directed Phase 4 decision): assigns, reassigns, or (Task #8)
 * unassigns `Load.assignedDispatcherId`, never a prerequisite for any
 * other Phase 4 transition. `null` explicitly means "unassign" — the
 * field must still be present in the request; omitting it entirely
 * remains invalid.
 */
export class AssignDispatcherDto {
  @ValidateIf((o: AssignDispatcherDto) => o.dispatcherUserId !== null)
  @IsUUID()
  dispatcherUserId!: string | null;
}
