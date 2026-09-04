/// <reference types="vite/client" />

declare const __MADPOST_ENV__: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  r2Region: string;
  githubRepo: string;
  githubToken: string;
  madpostBaseUrl: string;
};

declare const __MADPOST_VERSION__: string;
