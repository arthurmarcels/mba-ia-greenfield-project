import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1782481082147 implements MigrationInterface {
  name = 'CreateVideos1782481082147';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."video_status_enum" AS ENUM('draft', 'uploading', 'processing', 'ready', 'error')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "slug" character varying(21) NOT NULL, "title" character varying(255) NOT NULL, "description" text, "channel_id" uuid NOT NULL, "status" "public"."video_status_enum" NOT NULL DEFAULT 'draft', "duration_seconds" integer, "metadata" jsonb, "video_storage_key" character varying, "thumbnail_storage_key" character varying, "multipart_upload_id" character varying, "file_size_bytes" bigint, "mime_type" character varying, "error_message" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5dbcc1ee100f853490582eccc71" UNIQUE ("slug"), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_videos_channel_id" ON "videos" ("channel_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_videos_channel_id"`);
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."video_status_enum"`);
  }
}
