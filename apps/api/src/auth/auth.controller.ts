import type { Response } from "express";

import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from "@nestjs/common";

import type { AuthedRequest } from "./auth.middleware";
import { AUTH_COOKIE_NAME, authCookieOptions, AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    if (!this.authService.verifyCredentials(dto.username, dto.password)) {
      throw new UnauthorizedException("用户名或密码错误");
    }
    res.cookie(AUTH_COOKIE_NAME, this.authService.issueToken(), authCookieOptions);
    return { username: dto.username };
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(AUTH_COOKIE_NAME, { path: "/" });
    return { ok: true };
  }

  @Get("me")
  me(@Req() req: AuthedRequest) {
    return { username: req.authUser!.username };
  }
}
