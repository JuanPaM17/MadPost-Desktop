const defaultBaseUrl = "https://madpost.bizzify.lat";

class AppConfig {
  supabaseUrl() { return __MADPOST_ENV__.supabaseUrl; }
  supabaseAnonKey() { return __MADPOST_ENV__.supabaseAnonKey; }
  supabaseServiceRoleKey() { return __MADPOST_ENV__.supabaseServiceRoleKey; }
  githubRepo() { return __MADPOST_ENV__.githubRepo; }
  githubToken() { return __MADPOST_ENV__.githubToken; }
  r2Endpoint() { return __MADPOST_ENV__.r2Endpoint; }
  r2AccessKeyId() { return __MADPOST_ENV__.r2AccessKeyId; }
  r2SecretAccessKey() { return __MADPOST_ENV__.r2SecretAccessKey; }
  r2Bucket() { return __MADPOST_ENV__.r2Bucket; }
  r2Region() { return __MADPOST_ENV__.r2Region || "auto"; }
  baseUrl() { return ( __MADPOST_ENV__.madpostBaseUrl || defaultBaseUrl).replace(/\/+$/, ""); }
  helpUrl() { return `${this.baseUrl()}/ayuda?platform=desktop`; }
}

export const appConfig = new AppConfig();
