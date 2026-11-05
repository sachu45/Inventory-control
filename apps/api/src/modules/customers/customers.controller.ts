import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomersService } from './customers.service';
import { RequiresModule } from '../../common/config/requires-module.decorator';
import { CustomFieldsWrite } from '../../common/config/custom-field-values';
import { CustomFieldsFilter } from '../../common/config/custom-field-values';

@ApiTags('customers')
@ApiBearerAuth()
@RequiresModule('customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequirePermission('shop:read')
  @CustomFieldsFilter()
  @Get()
  @ApiOperation({ summary: 'List customers (paginated, shop-scoped)' })
  list(@CurrentUser() user: RequestUser, @Query() query: ListCustomersDto) {
    return this.customers.list(user, query);
  }

  @RequirePermission('shop:write')
  @CustomFieldsWrite('create')
  @Post()
  @ApiOperation({ summary: 'Create a customer' })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(user, dto);
  }

  @RequirePermission('shop:read')
  @Get(':id')
  @ApiOperation({ summary: 'Get a customer by id' })
  get(@CurrentUser() user: RequestUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.customers.get(user, id);
  }

  @RequirePermission('shop:write')
  @CustomFieldsWrite('update')
  @Patch(':id')
  @ApiOperation({ summary: 'Update a customer' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(user, id, dto);
  }
}

