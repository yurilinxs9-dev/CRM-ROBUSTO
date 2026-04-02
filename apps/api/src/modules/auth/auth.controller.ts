import { Controller, Post, Body, Get, Req, Res, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from '../../common/decorators/public.decorator';
import { Request, Response } from 'express';
import { z } from 'zod';

const loginSchema = z.object({
  email: z.string().email(),
  senha: z.string().min(6),
});

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, senha } = loginSchema.parse(body);
    const { accessToken, refreshToken } = await this.authService.login(email, senha);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth/refresh',
    });

    return { accessToken };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.refresh_token;
    if (!token) throw new Error('No refresh token');
    const { accessToken, refreshToken } = await this.authService.refreshToken(token);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
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
  async me(@Req() req: Request & { user: Record<string, unknown> }) {
    return req.user;
  }
}
