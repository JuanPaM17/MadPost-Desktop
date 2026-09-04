import { runtimeLogger } from "../runtime/RuntimeLogger";

class ConnectivityMonitor {
  private started = false;
  private online = navigator.onLine;
  private readonly listeners = new Set<(online: boolean, previousOnline: boolean) => void>();
  private readonly onOnline = () => { const previous = this.online; this.online = true; runtimeLogger.info("ConnectivityMonitor", "Conexion disponible."); this.listeners.forEach((listener) => listener(true, previous)); };
  private readonly onOffline = () => { this.online = false; runtimeLogger.info("ConnectivityMonitor", "Sin conexion."); };

  start() {
    if (this.started) return;
    this.started = true;
    this.online = navigator.onLine;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    runtimeLogger.info("ConnectivityMonitor", "Iniciado.", { online: this.online });
  }

  stop() {
    if (!this.started) return;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    this.started = false;
  }

  isOnline() { return this.online; }
  subscribe(listener: (online: boolean, previousOnline: boolean) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

export const connectivityMonitor = new ConnectivityMonitor();
