import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from '../videos/entities/video.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1782481082147 } from './migrations/1782481082147-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'videos',
  'refresh_tokens',
  'verification_tokens',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, Video, RefreshToken, VerificationToken],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1782481082147,
        ],
      },
    );

    await dataSource.initialize();

    // DROPs sequenciais (não Promise.all): `DROP TABLE ... CASCADE`
    // concorrentes em tabelas com FK (channels → users) adquirem locks em
    // ordem conflitante e disparam "deadlock detected" quando as tabelas já
    // existem (banco populado por outras suítes ou por migration:run).
    // Serializar elimina a corrida sem alterar o estado final.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // Outras suítes de integração usam synchronize:true (default do
    // createTestDataSource), que cria tipos enum a partir das entidades e os
    // deixa órfãos quando suas tabelas são removidas. Limpa qualquer enum
    // residual para que os migrations abaixo possam CREATE TYPE sem colisão.
    // Conforme .claude/rules/typeorm-migrations.md ("Migration Tests Must
    // Restore DB State").
    await dataSource.query(
      `DO $$ DECLARE r record; BEGIN
         FOR r IN SELECT typname FROM pg_type t
                  JOIN pg_namespace n ON t.typnamespace = n.oid
                  WHERE n.nspname = 'public' AND t.typtype = 'e'
         LOOP EXECUTE 'DROP TYPE IF EXISTS public."' || r.typname || '" CASCADE';
         END LOOP;
       END $$`,
    );
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create all five tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove videos table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(result).toHaveLength(0);
  });
});
