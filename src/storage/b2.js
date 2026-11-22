import { signRequest, sha256hex, EMPTY_HASH } from './s3sign.js';

// Backblaze B2 через S3-совместимый API. Адрес (endpoint) берётся из B2_ENDPOINT
// или узнаётся автоматически через b2_authorize_account.
export function createB2Storage({ keyId, key, bucket, endpoint }) {
  let base = endpoint;

  async function resolveEndpoint() {
    if (base) return base;
    const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
      headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${key}`).toString('base64') },
    });
    if (!res.ok) throw new Error(`B2: кілт қабылданбады (${res.status})`);
    const info = await res.json();
    base = info.apiInfo?.storageApi?.s3ApiUrl;
    if (!base) throw new Error('B2: s3ApiUrl табылмады');
    return base;
  }

  async function request(method, objectKey, body) {
    const url = new URL(await resolveEndpoint());
    const region = (/^s3\.([^.]+)\./.exec(url.hostname) || [])[1] || 'us-east-1';
    const path = `/${bucket}/${objectKey}`;
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const headers = body ? { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } : {};
    const signed = signRequest({
      method, host: url.host, path, headers, amzDate, region,
      payloadHash: body ? sha256hex(body) : EMPTY_HASH,
      accessKey: keyId, secretKey: key,
    });
    const { host, ...sendHeaders } = signed.headers;
    const res = await fetch(`${url.origin}${path}`, { method, headers: sendHeaders, body });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      throw new Error(`B2 ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res;
  }

  return {
    name: 'b2',
    async put(objectKey, buf) {
      await request('PUT', `materials/${objectKey}`, buf);
    },
    async get(objectKey) {
      const res = await request('GET', `materials/${objectKey}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async del(objectKey) {
      await request('DELETE', `materials/${objectKey}`);
    },
  };
}
