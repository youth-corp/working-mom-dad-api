import { ConflictException, Injectable } from '@nestjs/common';
import { NotificationPreferenceType, Prisma } from '@prisma/client';
import { REQUIRED_CONSENT_TYPES } from '../consents/consent.constants';
import {
  getConsents,
  recordConsent,
  type PrismaLike,
} from '../consents/consents.repository';
import { defaultNotificationTime } from '../notifications/notification-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto';

const NOTIFICATION_TYPES: NotificationPreferenceType[] = [
  'play_10min',
  'weekly_report',
];

/**
 * 온보딩 동의 기록 (docs/features/20260729-consent-storage.md §4.1).
 *
 * - 필수 2건은 항상 남긴다. DTO가 `true`만 통과시키므로 여기 도달하면 동의된 것.
 * - `consents` 자체가 없는 요청(구버전 WebView 캐시)은 필수 2건을 `backfill`로 기록해
 *   "사용자가 실제로 체크한 것"과 구분한다.
 * - 마케팅은 **true일 때만** row를 만든다. false로 row를 남기면 "거부 의사 표시"라는
 *   다른 의미가 되어 버린다 — 값이 안 온 것과 거부는 다르다.
 */
async function recordOnboardingConsents(
  tx: PrismaLike,
  userId: string,
  consents: CompleteOnboardingDto['consents'],
) {
  const source = consents ? 'user_action' : 'backfill';
  const note = consents
    ? undefined
    : 'consents 미포함 요청 — 온보딩 필수동의 강제 플로우 기반 기록';

  for (const type of REQUIRED_CONSENT_TYPES) {
    await recordConsent(tx, { userId, type, agreed: true, source, note });
  }

  if (consents?.marketing) {
    await recordConsent(tx, { userId, type: 'marketing', agreed: true });
  }
}

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 온보딩 일괄 완료 처리.
   * 첫 호출 시 도메인 User row를 lazy-create한다 (Supabase auth.users.id 기준).
   * 이미 완료(`onboardedAt != null`)된 사용자는 409.
   */
  async complete(userId: string, dto: CompleteOnboardingDto) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, onboardedAt: true, deletedAt: true },
      });

      if (user?.onboardedAt && !user.deletedAt) {
        throw new ConflictException({
          code: 'ONBOARDING_ALREADY_COMPLETED',
          onboardedAt: user.onboardedAt.toISOString(),
        });
      }

      const data = {
        name: dto.parent.name,
        birthDate: dto.parent.birthDate ? new Date(dto.parent.birthDate) : null,
        gender: dto.parent.gender ?? null,
        workStatus: dto.parent.workStatus ?? null,
        notificationSlot: dto.notification?.slot ?? null,
        notificationTime: dto.notification?.time ?? null,
        interests: dto.interests ?? [],
        onboardedAt: new Date(),
        notificationPromptShownAt: null,
        deletedAt: null,
        deletionReason: null,
      };
      const createData: Prisma.UserUncheckedCreateInput = {
        id: userId,
        ...data,
      };
      const updateData: Prisma.UserUncheckedUpdateInput = data;

      if (user?.deletedAt) {
        await tx.child.updateMany({
          where: { userId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        // 탈퇴 후 재온보딩 — 같은 userId(Supabase uid)를 재사용하므로 옛 채팅
        // 세션/메시지가 그대로 남아 새 자녀 정보와 충돌한다(삭제된 자녀 이름이
        // 히스토리에 남아 답변에 인용됨). 대화는 의도적으로 초기화.
        // ChatSession→ChatMessage→(cards/sourceLinks/tags/retrievals) 모두 cascade.
        await tx.chatSession.deleteMany({ where: { userId } });
      }

      await tx.user.upsert({
        where: { id: userId },
        create: createData,
        update: updateData,
      });

      for (const type of NOTIFICATION_TYPES) {
        await tx.notificationPreference.upsert({
          where: { userId_type: { userId, type } },
          create: {
            userId,
            type,
            enabled: Boolean(dto.notification),
            time:
              type === 'play_10min'
                ? resolvePlayNotificationTime(dto.notification)
                : defaultNotificationTime(type),
          },
          update: {
            enabled: Boolean(dto.notification),
            time:
              type === 'play_10min'
                ? resolvePlayNotificationTime(dto.notification)
                : defaultNotificationTime(type),
          },
        });
      }

      await tx.child.createMany({
        data: dto.children.map((c, idx) => ({
          userId,
          name: c.name,
          birthDate: new Date(c.birthDate),
          gender: c.gender,
          notes: c.notes ?? null,
          displayOrder: idx,
        })),
      });

      await recordOnboardingConsents(tx, userId, dto.consents);

      return this.getMe(tx, userId);
    });
  }

  /**
   * 트랜잭션 또는 일반 prisma client 모두에서 호출 가능한 me 조회.
   * 도메인 row가 아직 없는(가입 직후 미온보딩) 사용자도 200을 받도록 placeholder 반환.
   * onboardedAt: null이 미완료 신호 — 클라이언트는 이걸로 /onboarding 리디렉트한다.
   */
  async getMe(
    client:
      | PrismaService
      | Omit<Prisma.TransactionClient, '$connect' | '$disconnect'>,
    userId: string,
  ) {
    const [me, consents] = await Promise.all([
      client.user.findUnique({
        where: { id: userId },
        include: {
          children: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
          },
          notificationPreferences: { orderBy: { type: 'asc' } },
        },
      }),
      getConsents(client, userId),
    ]);
    if (me && !me.deletedAt) return { ...me, consents };

    // 탈퇴·미가입 사용자는 동의 이력을 노출하지 않는다 — 노출할 세션 컨텍스트가 없다.
    const emptyConsents = { service: null, privacy: null, marketing: null };

    if (me?.deletedAt) {
      return {
        id: userId,
        name: null,
        birthDate: null,
        gender: null,
        workStatus: null,
        notificationSlot: null,
        notificationTime: null,
        interests: [],
        onboardedAt: null,
        parentingStyleId: null,
        deletedAt: me.deletedAt,
        deletionReason: me.deletionReason,
        createdAt: me.createdAt,
        updatedAt: me.updatedAt,
        children: [],
        notificationPreferences: [],
        consents: emptyConsents,
      };
    }

    return {
      id: userId,
      name: null,
      birthDate: null,
      gender: null,
      workStatus: null,
      notificationSlot: null,
      notificationTime: null,
      interests: [],
      onboardedAt: null,
      parentingStyleId: null,
      deletedAt: null,
      deletionReason: null,
      createdAt: null,
      updatedAt: null,
      children: [],
      notificationPreferences: [],
      consents: emptyConsents,
    };
  }
}

function resolvePlayNotificationTime(
  notification: CompleteOnboardingDto['notification'],
): string {
  if (notification?.time) {
    return notification.time;
  }

  switch (notification?.slot) {
    case 'morning':
      return '08:00';
    case 'afternoon':
      return '12:00';
    case 'evening':
      return '18:00';
    case 'night':
      return '22:00';
    case 'custom':
      return '08:00';
    default:
      return defaultNotificationTime('play_10min');
  }
}
