import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { InvoiceStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { CursorPageDto } from '../../../common/dto/cursor-page.dto';
import { DateRangeQueryDto } from '../../../common/dto/date-range.dto';
import { CustomFieldFilterProperty } from '../../../common/config/custom-field-values';

export class ListInvoicesDto extends IntersectionType(CursorPageDto, DateRangeQueryDto) {
  @CustomFieldFilterProperty()
  cf?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  shop_id?: string;

  @ApiPropertyOptional({ enum: InvoiceStatus })
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customer_id?: string;
}
