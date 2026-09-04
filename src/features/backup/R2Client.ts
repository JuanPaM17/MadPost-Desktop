type R2Object = { key: string; lastModified: Date; size: number };
import { appConfig } from "../../config/AppConfig";

class R2Client {
  private readonly endpoint = appConfig.r2Endpoint().replace(/\/$/, "");
  private readonly accessKeyId = appConfig.r2AccessKeyId();
  private readonly secretAccessKey = appConfig.r2SecretAccessKey();
  private readonly bucket = appConfig.r2Bucket();
  private readonly region = appConfig.r2Region();

  isConfigured() { return Boolean(this.endpoint && this.accessKeyId && this.secretAccessKey && this.bucket); }

  async putObject(key: string, body: Uint8Array) { await this.request("PUT", key, body); }
  async deleteObject(key: string) { await this.request("DELETE", key); }

  async listObjects(prefix: string): Promise<R2Object[]> {
    const query = `list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const response = await this.request("GET", "", undefined, query);
    const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
    return [...xml.getElementsByTagName("Contents")].map((node) => ({
      key: node.getElementsByTagName("Key")[0]?.textContent ?? "",
      lastModified: new Date(node.getElementsByTagName("LastModified")[0]?.textContent ?? 0),
      size: Number(node.getElementsByTagName("Size")[0]?.textContent ?? 0),
    }));
  }

  private async request(method: "GET" | "PUT" | "DELETE", key: string, body?: Uint8Array, query = "") {
    if (!this.isConfigured()) throw new Error("R2 no esta configurado.");
    const now = new Date();
    const dateStamp = formatUtcDate(now);
    const amzDate = `${dateStamp}T${formatUtcTime(now)}Z`;
    const payload = body ?? new Uint8Array();
    const payloadHash = await sha256(payload);
    const host = new URL(this.endpoint).host;
    const encodedKey = encodeObjectKey(key);
    const canonicalUri = `/${this.bucket}/${encodedKey}`;
    const contentType = method === "PUT" ? "application/octet-stream" : undefined;
    const headers = [
      ...(contentType ? [["content-type", contentType] as const] : []),
      ["host", host] as const,
      ["x-amz-content-sha256", payloadHash] as const,
      ["x-amz-date", amzDate] as const,
    ];
    const canonicalHeaders = headers.map(([name, value]) => `${name}:${value}\n`).join("");
    const signedHeaders = headers.map(([name]) => name).join(";");
    const canonicalRequest = `${method}\n${canonicalUri}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(new TextEncoder().encode(canonicalRequest))}`;
    const signingKey = await this.signingKey(dateStamp);
    const signature = await hmacHex(signingKey, stringToSign);
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `${this.endpoint}/${this.bucket}/${encodedKey}${query ? `?${query}` : ""}`;
    const response = await fetch(url, { method, headers: { ...(contentType ? { "Content-Type": contentType } : {}), "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, Authorization: authorization }, body: method === "PUT" && body ? toArrayBuffer(body) : undefined });
    if (!response.ok) throw new Error(`R2 ${method} fallo: ${response.status}`);
    return response;
  }

  private async signingKey(dateStamp: string) {
    let key = new TextEncoder().encode(`AWS4${this.secretAccessKey}`);
    key = await hmacBytes(key, dateStamp); key = await hmacBytes(key, this.region); key = await hmacBytes(key, "s3");
    return hmacBytes(key, "aws4_request");
  }
}

function formatUtcDate(date: Date) { return date.toISOString().slice(0, 10).replaceAll("-", ""); }
function formatUtcTime(date: Date) { return date.toISOString().slice(11, 19).replaceAll(":", ""); }
function encodeObjectKey(key: string) { return key.split("/").map((part) => encodeURIComponent(part)).join("/"); }
function toArrayBuffer(data: Uint8Array) { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer; }
async function sha256(data: Uint8Array) { return toHex(await crypto.subtle.digest("SHA-256", toArrayBuffer(data))); }
async function hmacBytes(key: Uint8Array, data: string) { const cryptoKey = await crypto.subtle.importKey("raw", toArrayBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(new TextEncoder().encode(data)))); }
async function hmacHex(key: Uint8Array, data: string) { return toHex(await hmacBytes(key, data)); }
function toHex(buffer: ArrayBuffer | Uint8Array) { return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

export const r2Client = new R2Client();
