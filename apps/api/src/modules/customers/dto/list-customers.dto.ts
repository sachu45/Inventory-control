import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CursorPageDto } from '../../../common/dto/cursor-page.dto';
import { CustomFieldFilterProperty } from '../../../common/config/custom-field-values';

export class ListCustomersDto extends CursorPageDto {
  @CustomFieldFilterProperty()
  cf?: string;

  @ApiPropertyOptional({ description: 'Substring match on customerCode or customerName (case-insensitive).' })
  @IsOptional()
  @IsString()
  search?: string;
}
