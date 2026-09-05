use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::blocking::{Client, Response};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize)]
pub struct R2ConnectionCheck { pub connected: bool, pub missing: Vec<String>, pub endpoint: Option<String>, pub bucket: Option<String>, pub reason: Option<String> }

pub struct R2Client { endpoint: String, access_key: String, secret: String, bucket: String, region: String, client: Client }

impl R2Client {
    pub fn from_embedded() -> Option<Self> {
        let endpoint = option_env!("MADPOST_R2_ENDPOINT").unwrap_or("").trim().trim_end_matches('/').to_string();
        let access_key = option_env!("MADPOST_R2_ACCESS_KEY_ID").unwrap_or("").trim().to_string();
        let secret = option_env!("MADPOST_R2_SECRET_ACCESS_KEY").unwrap_or("").trim().to_string();
        let bucket = option_env!("MADPOST_R2_BUCKET").unwrap_or("").trim().to_string();
        if endpoint.is_empty() || access_key.is_empty() || secret.is_empty() || bucket.is_empty() { return None; }
        Some(Self { endpoint, access_key, secret, bucket, region: option_env!("MADPOST_R2_REGION").unwrap_or("auto").trim().to_string(), client: Client::builder().timeout(Duration::from_secs(8)).build().ok()? })
    }

    pub fn put_object(&self, key: &str, data: &[u8]) -> Result<(), String> { self.request("PUT", key, Some(data), "").map(|_| ()) }
    pub fn delete_object(&self, key: &str) -> Result<(), String> { self.request("DELETE", key, None, "").map(|_| ()) }
    pub fn list_objects_xml(&self, prefix: &str) -> Result<String, String> { self.request("GET", "", None, &format!("list-type=2&prefix={}", encode_component(prefix))).and_then(|response| response.text().map_err(|error| error.to_string())) }
    pub fn test_connection(&self) -> Result<(), String> { self.request("GET", "", None, "list-type=2&max-keys=1").map(|_| ()) }
    fn endpoint_host(&self) -> String { self.endpoint.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or_default().to_string() }

    fn request(&self, method: &str, key: &str, body: Option<&[u8]>, query: &str) -> Result<Response, String> {
        let now = Utc::now();
        let date_stamp = now.format("%Y%m%d").to_string();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let payload = body.unwrap_or(&[]);
        let payload_hash = hash(payload);
        let encoded_key = encode_key(key);
        let canonical_uri = if encoded_key.is_empty() { format!("/{}/", self.bucket) } else { format!("/{}/{}", self.bucket, encoded_key) };
        let content_type = (method == "PUT").then_some("application/octet-stream");
        let host = self.endpoint_host();
        let canonical_headers = if let Some(content_type) = content_type { format!("content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n") } else { format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n") };
        let signed_headers = if content_type.is_some() { "content-type;host;x-amz-content-sha256;x-amz-date" } else { "host;x-amz-content-sha256;x-amz-date" };
        let canonical_request = format!("{method}\n{canonical_uri}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
        let authorization = self.authorization(&canonical_request, signed_headers, &date_stamp, &amz_date)?;
        let url = format!("{}{}{}", self.endpoint, canonical_uri, if query.is_empty() { "".to_string() } else { format!("?{query}") });
        let request = match method { "GET" => self.client.get(url), "PUT" => self.client.put(url).body(payload.to_vec()), "DELETE" => self.client.delete(url), _ => return Err("Metodo R2 no soportado.".to_string()) }
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", amz_date)
            .header("Authorization", authorization);
        let request = if let Some(content_type) = content_type { request.header("Content-Type", content_type) } else { request };
        let response = request.send().map_err(|error| error.to_string())?;
        if response.status().is_success() { Ok(response) } else { let status = response.status(); let detail = response.text().unwrap_or_default(); Err(format!("R2 respondio HTTP {status}: {}", detail.chars().take(300).collect::<String>())) }
    }

    fn authorization(&self, canonical: &str, signed: &str, date_stamp: &str, amz_date: &str) -> Result<String, String> {
        let scope = format!("{date_stamp}/{}/s3/aws4_request", self.region);
        let string = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hash(canonical.as_bytes()));
        let mut key = hmac(format!("AWS4{}", self.secret).as_bytes(), date_stamp)?;
        key = hmac(&key, &self.region)?; key = hmac(&key, "s3")?; key = hmac(&key, "aws4_request")?;
        Ok(format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed}, Signature={}", self.access_key, hex(&hmac(&key, &string)?)))
    }
}

pub fn configuration_check() -> R2ConnectionCheck {
    let configured = configuration_status();
    if !configured.missing.is_empty() { return configured; }
    let client = match R2Client::from_embedded() { Some(client) => client, None => return R2ConnectionCheck { connected: false, missing: vec!["r2.endpoint".to_string()], endpoint: None, bucket: None, reason: None } };
    match client.test_connection() { Ok(()) => R2ConnectionCheck { connected: true, missing: vec![], endpoint: Some(client.endpoint_host()), bucket: Some(client.bucket), reason: None }, Err(error) => R2ConnectionCheck { connected: false, missing: vec![], endpoint: Some(client.endpoint_host()), bucket: Some(client.bucket), reason: Some(error) } }
}
pub fn configuration_status() -> R2ConnectionCheck {
    let missing = [("r2.endpoint", option_env!("MADPOST_R2_ENDPOINT")), ("r2.access_key_id", option_env!("MADPOST_R2_ACCESS_KEY_ID")), ("r2.secret_access_key", option_env!("MADPOST_R2_SECRET_ACCESS_KEY")), ("r2.bucket", option_env!("MADPOST_R2_BUCKET"))].into_iter().filter_map(|(name, value)| value.filter(|value| !value.trim().is_empty()).is_none().then_some(name.to_string())).collect::<Vec<_>>();
    let endpoint = option_env!("MADPOST_R2_ENDPOINT").filter(|value| !value.trim().is_empty()).map(|value| value.trim().trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or_default().to_string());
    let bucket = option_env!("MADPOST_R2_BUCKET").filter(|value| !value.trim().is_empty()).map(str::to_string);
    R2ConnectionCheck { connected: missing.is_empty(), missing, endpoint, bucket, reason: None }
}
pub fn list_objects(prefix: String) -> Result<String, String> { R2Client::from_embedded().ok_or_else(|| "R2 no esta configurado.".to_string())?.list_objects_xml(&prefix) }
pub fn put_object(key: String, body: Vec<u8>) -> Result<(), String> { R2Client::from_embedded().ok_or_else(|| "R2 no esta configurado.".to_string())?.put_object(&key, &body) }
pub fn delete_object(key: String) -> Result<(), String> { R2Client::from_embedded().ok_or_else(|| "R2 no esta configurado.".to_string())?.delete_object(&key) }

fn hmac(key: &[u8], value: &str) -> Result<Vec<u8>, String> { let mut mac = HmacSha256::new_from_slice(key).map_err(|error| error.to_string())?; mac.update(value.as_bytes()); Ok(mac.finalize().into_bytes().to_vec()) }
fn hash(value: &[u8]) -> String { hex(&Sha256::digest(value)) }
fn hex(value: &[u8]) -> String { value.iter().map(|byte| format!("{byte:02x}")).collect() }
fn encode_key(value: &str) -> String { value.split('/').map(encode_component).collect::<Vec<_>>().join("/") }
fn encode_component(value: &str) -> String { value.bytes().map(|byte| if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect() }
