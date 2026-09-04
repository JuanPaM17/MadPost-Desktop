import { BaseDirectory, mkdir, open } from "@tauri-apps/plugin-fs";

type LogDetails = Record<string, string | number | boolean | undefined>;

class RuntimeLogger {
  info(service: string, message: string, details: LogDetails = {}) {
    const renderedDetails = Object.entries(details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    const line = `[${new Date().toISOString()}] [${service}] ${message}${renderedDetails ? ` ${renderedDetails}` : ""}`;
    console.info(line);
    void this.persist(line);
  }

  error(service: string, message: string, error: unknown) {
    const line = `[${new Date().toISOString()}] [${service}] ${message} ${error instanceof Error ? error.message : String(error)}`;
    console.error(line, error);
    void this.persist(line);
  }

  private async persist(line: string) {
    try {
      await mkdir("logs", { baseDir: BaseDirectory.AppData, recursive: true });
      const fileName = `logs/madpost-${new Date().toISOString().slice(0, 10)}.log`;
      const file = await open(fileName, { baseDir: BaseDirectory.AppData, append: true, create: true });
      await file.write(new TextEncoder().encode(`${line}\n`));
      await file.close();
    } catch {
      // Console logging remains available when the native filesystem is unavailable.
    }
  }
}

export const runtimeLogger = new RuntimeLogger();
