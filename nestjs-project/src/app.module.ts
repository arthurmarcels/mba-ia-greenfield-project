import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import appConfig from './config/app.config';
import authConfig from './config/auth.config';
import databaseConfig from './config/database.config';
import mailConfig from './config/mail.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import swaggerConfig from './config/swagger.config';
import { envValidationSchema } from './config/env.validation';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './videos/storage/storage.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        databaseConfig,
        mailConfig,
        storageConfig,
        queueConfig,
        swaggerConfig,
      ],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    AuthModule,
    QueueModule,
    StorageModule,
    VideosModule,
    // NOTE: the BullMQ consumer (ProcessingModule / the video @Processor) is
    // intentionally NOT imported here — the API only publishes jobs, it must not
    // also consume them. The consumer lives in WorkerAppModule (src/worker.ts),
    // so it is absent from this API process and from every e2e boot. Keeping the
    // worker out of AppModule is also what prevents its blocking-connection
    // teardown (`Connection is closed.`) from flaking the e2e suite (AMS-390).
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
