import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1782478498145 implements MigrationInterface {
  name = 'CreateVideos1782478498145';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create the video_status_enum type with explicit singular name
    await queryRunner.query(
      `CREATE TYPE "video_status_enum" AS ENUM ('draft', 'uploading', 'processing', 'ready', 'error')`,
    );

    // Create the videos table with all columns, constraints, and indexes
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "slug" character varying(21) NOT NULL, "title" character varying(255) NOT NULL, "description" text, "channel_id" uuid NOT NULL, "status" "video_status_enum" NOT NULL DEFAULT 'draft', "duration_seconds" integer, "metadata" jsonb, "video_storage_key" character varying, "thumbnail_storage_key" character varying, "multipart_upload_id" character varying, "file_size_bytes" bigint, "mime_type" character varying, "error_message" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_81234567890abcdef1234567890ab" UNIQUE ("slug"), CONSTRAINT "PK_81234567890abcdef1234567890ab" PRIMARY KEY ("id"))`,
    );

    // Create index on channel_id
    await queryRunner.query(
      `CREATE INDEX "idx_videos_channel_id" ON "videos" ("channel_id")`,
    );

    // Add foreign key constraint to channels
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_channel_id" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign key constraint
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_videos_channel_id"`,
    );

    // Drop index on channel_id
    await queryRunner.query(`DROP INDEX "idx_videos_channel_id"`);

    // Drop videos table
    await queryRunner.query(`DROP TABLE "videos"`);

    // Drop video_status_enum type
    await queryRunner.query(`DROP TYPE "video_status_enum"`);
  }
}
