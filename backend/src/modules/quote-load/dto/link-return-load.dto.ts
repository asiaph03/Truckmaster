import { IsUUID } from 'class-validator';

/**
 * Return Product feature — the lighter, post-creation linking approach
 * (approved over adding `returnForLoadId` to `CreateLoadDto`, keeping
 * Create Load's own flow unchanged): `PATCH /loads/:id/link-return`
 * points this Load at the original Load it exists because of.
 */
export class LinkReturnLoadDto {
  @IsUUID()
  returnForLoadId!: string;
}
