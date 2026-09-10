import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { NotificationPreferenceType, Prisma } from '@prisma/client';
import { isOptionalConsentType } from '../consents/consent.constants';
import { recordConsent } from '../consents/consents.repository';
import { defaultNotificationTime } from '../notifications/notification-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import type { UpdateConsentDto } from './dto/update-consent.dto';
import type { UpdateParentDto } from './dto/update-parent.dto';
import type { UpdateInterestsDto } from './dto/update-interests.dto';
import type { UpsertNotificationPreferenceDto } from './dto/upsert-notification-preference.dto';
import type { DeleteAccountDto } from './dto/delete-account.dto';

/**
 * 설정(Settings) 도메인 — 온보딩 후 사용자가 자신의 데이터를 수정·삭제.
 * docs/features/20260519-settings.md 참조.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly onboarding: OnboardingService,
  ) {}

  /** POST /me/notification-prompt-exposure — 계정 기준 최초 실제 모달 노출을 원자적으로 예약한다. */
  async claimNotificationPromptExposure(userId: string) {
    const result = await this.prisma.user.updateMany({
      where: {
        id: userId,
        deletedAt: null,
        notificationPromptShownAt: null,
      },
      data: { notificationPromptShownAt: new Date() },
    });

    return { shouldShow: result.count === 1 };
  }

  /** PATCH /me/parent — 본인 정보 부분 갱신. */
  async updateParent(userId: string, dto: UpdateParentDto) {
    const data: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.birthDate !== undefined) data.birthDate = new Date(dto.birthDate);
    if (dto.gender !== undefined) data.gender = dto.gender;
    // workStatus는 null로 명시 해제 가능
    if (dto.workStatus !== undefined) data.workStatus = dto.workStatus;

    try {
      await this.prisma.user.update({ where: { id: userId }, data });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new NotFoundException('USER_NOT_FOUND');
      }
      throw e;
    }
    return this.onboarding.getMe(this.prisma, userId);
  }

  /** PATCH /me/interests — 관심 주제 일괄 교체. */
  async updateInterests(userId: string, dto: UpdateInterestsDto) {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { interests: { set: dto.interests } },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new NotFoundException('USER_NOT_FOUND');
      }
      throw e;
    }
    return this.onboarding.getMe(this.prisma, userId);
  }

  /**
   * PATCH /me/notifications/:type — 알림 종류별 enabled + time upsert.
   * time 미지정 시 기존 row 보존, 없으면 09:00 기본값.
   */
  async upsertNotificationPreference(
    userId: string,
    type: NotificationPreferenceType,
    dto: UpsertNotificationPreferenceDto,
  ) {
    const existing = await this.prisma.notificationPreference.findUnique({
      where: { userId_type: { userId, type } },
    });
    const time = dto.time ?? existing?.time ?? defaultNotificationTime(type);
    return this.prisma.notificationPreference.upsert({
      where: { userId_type: { userId, type } },
      create: { userId, type, enabled: dto.enabled, time },
      update: { enabled: dto.enabled, time },
    });
  }

  /**
   * PATCH /me/consents/:type — 선택 동의 변경 (docs/features/20260729-consent-storage.md §4.3).
   *
   * 필수 2건(service·privacy)은 철회 대상이 아니다 — 철회 = 서비스 이용 불가라
   * 토글로 다룰 성질이 아니므로 400으로 막는다.
   * 기존 row를 고치지 않고 새 이력을 쌓는다 (append-only).
   */
  async updateConsent(userId: string, type: string, dto: UpdateConsentDto) {
    if (!isOptionalConsentType(type)) {
      throw new BadRequestException({
        code: 'CONSENT_TYPE_NOT_CHANGEABLE',
        message: `변경 가능한 동의 종류가 아닙니다: ${type}`,
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw new NotFoundException('USER_NOT_FOUND');

    await recordConsent(this.prisma, { userId, type, agreed: dto.agreed });
    return this.onboarding.getMe(this.prisma, userId);
  }

  /**
   * DELETE /me — 계정 탈퇴 (soft delete).
   * deletedAt set. 물리 삭제 배치는 후속 작업으로 분리한다.
   * 이미 탈퇴 처리된 사용자는 409.
   */
  async softDeleteAccount(userId: string, dto: DeleteAccountDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deletedAt: true },
    });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    if (user.deletedAt) {
      throw new ConflictException({
        code: 'ACCOUNT_ALREADY_DELETED',
        deletedAt: user.deletedAt.toISOString(),
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: new Date(),
          deletionReason: dto.reason ?? null,
        },
      });

      // 탈퇴 계정에 더 이상 발송하거나 노출할 이유가 없는 전달 주소와 알림함은
      // soft delete 유예 기간과 관계없이 즉시 제거한다.
      await tx.userPushToken.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });
    });
  }
}
