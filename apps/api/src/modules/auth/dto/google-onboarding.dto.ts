import { Equals, IsBoolean, IsIn, IsOptional, IsString, Length, MaxLength, Matches } from 'class-validator';

export class SignupIntentDto {
  @IsOptional() @IsIn(['pro', 'plus']) plan?: 'pro' | 'plus';
  @IsOptional() @IsIn(['monthly', 'yearly']) billing?: 'monthly' | 'yearly';
  @IsOptional() @IsBoolean() loginOnly?: boolean;
}
export class OnboardingWorkspaceDto {
  @IsString() @Length(2, 100) workspaceName!: string;
  @IsOptional() @IsString() @MaxLength(150) companyName?: string;
  @Equals(true) agreedToTerms!: boolean;
}
export class OnboardingLinkDto {
  @IsString() @Length(8, 128) password!: string;
}
export class OnboardingMfaDto {
  @IsString() @Length(10, 512) token!: string;
  @IsOptional() @Matches(/^\d{6}$/) code?: string;
  @IsOptional() @IsString() @Length(4, 64) backupCode?: string;
}
