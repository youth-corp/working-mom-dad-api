import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationPreferenceType } from '@prisma/client';
import { CurrentUserId } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SkipOnboardingCheck } from '../auth/skip-onboarding-check.decorator';
import { OnboardingService } from '../onboarding/onboarding.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { UpdateConsentDto } from './dto/update-consent.dto';
import { UpdateInterestsDto } from './dto/update-interests.dto';
import { UpdateParentDto } from './dto/update-parent.dto';
import { UpsertNotificationPreferenceDto } from './dto/upsert-notification-preference.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly onboarding: OnboardingService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @SkipOnboardingCheck()
  @ApiOperation({
    summary: '본인 정보 조회',
    description:
      'User + children(deletedAt 필터) + notificationPreferences 포함. onboardedAt이 null이면 미완료.',
  })
  async getMe(@CurrentUserId() userId: string) {
    return this.onboarding.getMe(this.prisma, userId);
  }

  @Post('notification-prompt-exposure')
  @ApiOperation({
    summary: '놀이 완료 알림 권한 안내를 계정당 최초 1회로 예약',
    description:
      '모달을 실제로 띄우기 직전에 호출한다. 동시 요청에도 최초 한 요청만 shouldShow=true를 받는다.',
  })
  async claimNotificationPromptExposure(@CurrentUserId() userId: string) {
    return this.users.claimNotificationPromptExposure(userId);
  }

  @Patch('parent')
  @ApiOperation({
    summary: '본인 정보 수정 (Figma 2395:9320)',
    description: '부분 갱신. name·birthDate·gender·workStatus 중 일부.',
  })
  async updateParent(
    @CurrentUserId() userId: string,
    @Body() body: UpdateParentDto,
  ) {
    return this.users.updateParent(userId, body);
  }

  @Patch('interests')
  @ApiOperation({
    summary: '관심 주제 수정 (Figma 2395:9162)',
    description: '최대 3개로 일괄 교체.',
  })
  async updateInterests(
    @CurrentUserId() userId: string,
    @Body() body: UpdateInterestsDto,
  ) {
    return this.users.updateInterests(userId, body);
  }

  @Patch('notifications/:type')
  @ApiParam({
    name: 'type',
    enum: ['play_10min', 'weekly_report'],
    description: '알림 종류.',
  })
  @ApiOperation({
    summary: '알림 종류별 enabled+time 설정 (Figma 2395:9126)',
    description:
      'play_10min(10분 놀이) 또는 weekly_report(주간 리포트) preference를 upsert.',
  })
  async upsertNotification(
    @CurrentUserId() userId: string,
    @Param('type') type: NotificationPreferenceType,
    @Body() body: UpsertNotificationPreferenceDto,
  ) {
    return this.users.upsertNotificationPreference(userId, type, body);
  }

  @Patch('consents/:type')
  @ApiParam({
    name: 'type',
    enum: ['marketing'],
    description:
      '변경 가능한 동의 종류. 필수 2건(service·privacy)은 철회 대상이 아니라 400.',
  })
  @ApiOperation({
    summary: '선택 동의 변경 (마케팅 수신)',
    description:
      'append-only — 기존 row를 고치지 않고 새 이력을 쌓는다. 철회 시각도 근거로 남는다.',
  })
  async updateConsent(
    @CurrentUserId() userId: string,
    @Param('type') type: string,
    @Body() body: UpdateConsentDto,
  ) {
    return this.users.updateConsent(userId, type, body);
  }

  @Delete()
  @HttpCode(204)
  @ApiNoContentResponse()
  @ApiOperation({
    summary: '계정 탈퇴 (Figma 2395:8988)',
    description:
      'soft delete (deletedAt set). 물리 삭제 배치는 후속 작업으로 분리한다.',
  })
  async deleteAccount(
    @CurrentUserId() userId: string,
    @Body() body: DeleteAccountDto,
  ): Promise<void> {
    return this.users.softDeleteAccount(userId, body);
  }
}
