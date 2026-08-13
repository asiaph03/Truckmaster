import { IsUUID } from 'class-validator';

export class SelectOrganizationDto {
  @IsUUID()
  organizationId!: string;
}
