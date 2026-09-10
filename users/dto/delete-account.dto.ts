import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** DELETE /me — 계정 탈퇴 (Figma 2395:8988). soft delete. */
export class DeleteAccountDto {
  @ApiPropertyOptional({
    description: '탈퇴 사유 (선택, 자유 텍스트). 통계·CS 용도.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
