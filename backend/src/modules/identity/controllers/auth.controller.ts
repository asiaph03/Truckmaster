import { Body, Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from '../services/auth.service';
import { MembershipService } from '../services/membership.service';
import { LoginDto } from '../dto/login.dto';
import { SelectOrganizationDto } from '../dto/select-organization.dto';
import { ActivateMembershipDto } from '../dto/activate-membership.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { Public } from '../../../common/decorators/public.decorator';
import { AuthenticationError } from '../../../common/errors/app-error';

/**
 * TECHNICAL_ARCHITECTURE.md §5.1 Auth resource row:
 *   POST /auth/login, POST /auth/logout, POST /auth/select-organization,
 *   POST /auth/switch-organization, PATCH /auth/me
 * Plus the invitation-acceptance endpoint (Workflow 1 §1.3/§1.5), grouped
 * here since it's part of the same identity-establishment surface.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly membershipService: MembershipService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const result = await this.authService.login(dto.email, dto.password);
    req.session.auth = result.session;
    return {
      requiresOrganizationSelection: result.requiresOrganizationSelection,
      organizations: result.organizations,
    };
  }

  @Public()
  @Post('activate')
  @HttpCode(200)
  async activate(@Body() dto: ActivateMembershipDto) {
    const membership = await this.membershipService.activate(dto.token, dto.password);
    return { membershipId: membership.id, organizationId: membership.organizationId };
  }

  @Post('select-organization')
  @HttpCode(200)
  async selectOrganization(@Body() dto: SelectOrganizationDto, @Req() req: Request) {
    const userId = req.session.auth?.userId;
    if (!userId) throw new AuthenticationError('Authentication required.');
    const session = await this.authService.selectOrganization(userId, dto.organizationId);
    req.session.auth = session;
    return { organizationId: session.organizationId, roles: session.roles };
  }

  @Post('switch-organization')
  @HttpCode(200)
  async switchOrganization(@Body() dto: SelectOrganizationDto, @Req() req: Request) {
    const userId = req.session.auth?.userId;
    if (!userId) throw new AuthenticationError('Authentication required.');
    // §3.3 — a full context switch, never a partial in-place merge.
    const session = await this.authService.switchOrganization(userId, dto.organizationId);
    req.session.auth = session;
    return { organizationId: session.organizationId, roles: session.roles };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request) {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy((err) => (err ? reject(err) : resolve()));
    });
    return { success: true };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const userId = req.session.auth?.userId;
    if (!userId) throw new AuthenticationError('Authentication required.');
    const profile = await this.authService.getProfile(userId);
    return {
      ...profile,
      organizationId: req.session.auth?.organizationId,
      roles: req.session.auth?.roles,
    };
  }

  @Patch('me')
  @HttpCode(200)
  async updateMe(@Body() dto: UpdateProfileDto, @Req() req: Request) {
    const userId = req.session.auth?.userId;
    if (!userId) throw new AuthenticationError('Authentication required.');
    await this.authService.updateProfile(userId, dto);
    return { success: true };
  }
}
