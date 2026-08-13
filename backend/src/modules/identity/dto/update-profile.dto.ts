import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * UI_UX_DESIGN.md §5.6 SH-9: "name and password only — organization
 * membership, roles, permissions, and other administrative identity
 * controls stay outside self-service editing." Deliberately has no
 * `email` or `roles` field — email is the login identity (changing it has
 * verification implications no workflow covers) and roles are
 * Admin/Workflow-1-governed only.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  password?: string;
}
