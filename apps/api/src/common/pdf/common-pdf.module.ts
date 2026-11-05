import { Module, OnModuleDestroy } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BrandingModule } from '../branding/branding.module';
import { DocumentPdfService } from './document-pdf.service';
import { closePdfBrowser } from './html-to-pdf.service';

@Module({
  imports: [PrismaModule, BrandingModule],
  providers: [DocumentPdfService],
  exports: [DocumentPdfService],
})
export class CommonPdfModule implements OnModuleDestroy {
  /**
   * The shared PDF browser is a module-level singleton, closed otherwise only on
   * `beforeExit`, which never fires when the process is ended for it (jest
   * --forceExit, process.exit). Close it with the app so each app.close()
   * leaves no Chromium behind.
   */
  async onModuleDestroy(): Promise<void> {
    await closePdfBrowser();
  }
}
