import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { CustomFieldsProperty } from '../../../common/config/custom-field-values';

export class CreateInvoiceDto {
  @CustomFieldsProperty()
  customFields?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  salesOrderId?: string;

  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  shopId?: string;

  @ApiProperty()
  @Type(() => Number)
  @Min(0)
  totalValue!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  remarks?: string;

  @ApiPropertyOptional({
    description: 'Client-supplied idempotency key (same contract as PO/SO/GR create)',
  })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

