import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class SetDraftModuleDto {
  /** `null` inherits (registry default, or the company value for a shop row). */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean | null;

  @IsObject()
  config!: Record<string, unknown>;

  /** Current revision of the draft row; omit only when creating the row. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision?: number;
}

export class ResetDraftModuleQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision?: number;
}

export class PublishConfigDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedBaseVersion!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListTenantsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;

  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export class EffectiveConfigQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  shopId?: string;
}

export class ConfigAuditQueryDto {
  @IsIn(['config'])
  type!: 'config';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;

  @IsOptional()
  @IsUUID()
  cursor?: string;
}
