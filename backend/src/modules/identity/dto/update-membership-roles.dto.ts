import { ArrayMinSize, IsArray, IsEnum } from 'class-validator';
import { MembershipRoleName } from '@prisma/client';

/** Frontend Phase 11 — replaces an existing active member's full role set. Mirrors InviteMemberDto's roles validation exactly. */
export class UpdateMembershipRolesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(MembershipRoleName, { each: true })
  roles!: MembershipRoleName[];
}
