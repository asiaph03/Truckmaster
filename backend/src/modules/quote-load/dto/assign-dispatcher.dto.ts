import { IsUUID } from 'class-validator';

/**
 * Independent action (Workflow 4 §4.11, Workflow 5 §5.8 — approved,
 * user-directed Phase 4 decision): assigns or reassigns
 * `Load.assignedDispatcherId`, never a prerequisite for any other Phase 4
 * transition.
 */
export class AssignDispatcherDto {
  @IsUUID()
  dispatcherUserId!: string;
}
