import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Global owner of object-storage access. The `storage` config namespace is
 * registered globally via `ConfigModule.forRoot`, so `StorageService` injects
 * `ConfigType<typeof storageConfig>` directly — the worker entrypoint
 * (`src/worker.ts`) and `VideosService` (SI-03.5) depend on it through DI
 * without importing this module.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
