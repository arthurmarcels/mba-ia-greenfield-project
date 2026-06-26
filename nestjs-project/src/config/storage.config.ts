import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'minio',
  port: parseInt(process.env.STORAGE_PORT || '9000', 10),
  useSsl: process.env.STORAGE_USE_SSL === 'true',
  accessKey: process.env.STORAGE_ACCESS_KEY!,
  secretKey: process.env.STORAGE_SECRET_KEY!,
  bucket: process.env.STORAGE_BUCKET || 'streamtube-media',
  publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL,
}));
