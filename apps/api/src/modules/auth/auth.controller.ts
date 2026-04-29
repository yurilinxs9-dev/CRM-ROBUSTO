import { Controller, Post, Body, Get, Req, Res, HttpCode, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Request, Response } from 'express';
import { z } from 'zod';

const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(6),
  remember: z.boolean().optional().default(false),
});

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function refreshCookieMaxAge(remember: boolean) {
  return remember ? ONE_YEAR_MS : SEVEN_DAYS_MS;
}

// Frontend (Vercel) e backend (DuckDNS) ficam em origens diferentes — refresh
// é XHR cross-site, então o cookie precisa de SameSite=None+Secure pra ser
// enviado. SameSite=Lax bloqueava o cookie em refresh, derrubando a sessão
// toda vez que o access token expirava.
const refreshCookieSameSite =
  process.env.NODE_ENV === 'production' ? ('none' as const) : ('lax' as const);
const refreshCookieSecure = process.env.NODE_ENV === 'production';

const registerSchema = z.object({
  nome: z.string().min(2).max(100),
  email: z.string().email(),
  senha: z.string().min(8).max(100),
  workspace_name: z.string().min(1).max(100).optional(),
});

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, senha, remember } = loginSchema.parse(body);
    const { accessToken, refreshToken } = await this.authService.login(email, senha, remember);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: refreshCookieSecure,
      sameSite: refreshCookieSameSite,
      maxAge: refreshCookieMaxAge(remember),
      path: '/api/auth/refresh',
    });

    return { accessToken };
  }

  @Public()
  @Post('register')
  @HttpCode(201)
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const data = registerSchema.parse(body);
    const user = await this.authService.createUser(data);
    // Novo cadastro vira sessão "lembrar de mim" — usuário acabou de criar a conta,
    // não faz sentido deslogar em 7 dias.
    const { accessToken, refreshToken, remember } = await this.authService.generateTokens(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id,
      },
      true,
    );
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: refreshCookieSecure,
      sameSite: refreshCookieSameSite,
      maxAge: refreshCookieMaxAge(remember),
      path: '/api/auth/refresh',
    });
    return { accessToken, user };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.refresh_token;
    if (!token) throw new UnauthorizedException('No refresh token');
    const { accessToken, refreshToken, remember } = await this.authService.refreshToken(token);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: refreshCookieSecure,
      sameSite: refreshCookieSameSite,
      maxAge: refreshCookieMaxAge(remember),
      path: '/api/auth/refresh',
    });

    return { accessToken };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
    return { message: 'Logged out' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: Request & { user: Record<string, unknown> }) {
    const user = req.user as { id?: string; tenantId?: string };
    if (!user?.id || !user?.tenantId) throw new UnauthorizedException();
    return this.authService.getMe(user.id, user.tenantId);
  }
}
