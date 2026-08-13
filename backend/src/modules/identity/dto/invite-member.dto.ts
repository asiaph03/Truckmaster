import { ArrayMinSize, IsArray, IsEmail, IsEnum } from 'class-validator';
import { MembershipRoleName } from '@prisma/client';

/**
 * Workflow 1 §1.4 — email + one or more roles.
 */
export class InviteMemberDto {
  @IsEmail()
  email!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(MembershipRoleName, { each: true })
  roles!: MembershipRoleName[];
}
