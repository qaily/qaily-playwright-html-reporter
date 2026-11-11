import { describe, expect, it } from 'vitest';
import { presignS3Get, s3EndpointUrl, uriEncode } from '../src/sigv4.ts';

// The presigned GET example from the AWS S3 documentation (sigv4-query-string-auth).
const AWS_EXAMPLE = {
  bucket: 'examplebucket',
  host: 'examplebucket.s3.amazonaws.com',
  region: 'us-east-1',
  key: 'test.txt',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  expiresIn: 86400,
  now: new Date('2013-05-24T00:00:00Z'),
};

describe('presignS3Get', () => {
  it('matches the AWS documented example signature', async () => {
    const url = new URL(await presignS3Get(AWS_EXAMPLE));
    expect(url.searchParams.get('X-Amz-Signature')).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(url.host).toBe('examplebucket.s3.amazonaws.com');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  });

  it('adds the session token and download name, and changes the signature', async () => {
    const base = new URL(await presignS3Get(AWS_EXAMPLE));
    const url = new URL(await presignS3Get({ ...AWS_EXAMPLE, sessionToken: 'tok/+=', downloadName: 'trace "1".zip' }));
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('tok/+=');
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="trace _1_.zip"');
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe(base.searchParams.get('X-Amz-Signature'));
  });

  it('uses the regional virtual-hosted endpoint and encodes keys per segment', async () => {
    const url = await presignS3Get({ ...AWS_EXAMPLE, host: undefined, region: 'eu-north-1', key: 'jsonl-report/run 1/attachments/a+b.png' });
    expect(url.startsWith('https://examplebucket.s3.eu-north-1.amazonaws.com/jsonl-report/run%201/attachments/a%2Bb.png?')).toBe(true);
  });
});

describe('S3-compatible endpoints', () => {
  const base = { ...AWS_EXAMPLE, host: undefined, key: 'a/b.png' };

  it('keeps the AWS URL when the endpoint is empty', async () => {
    const url = new URL(await presignS3Get({ ...base, endpoint: '', pathStyle: false }));
    expect(url.origin + url.pathname).toBe('https://examplebucket.s3.us-east-1.amazonaws.com/a/b.png');
  });

  it('puts the bucket in the host by default (Google Cloud Storage)', async () => {
    const url = new URL(await presignS3Get({ ...base, region: 'auto', endpoint: 'storage.googleapis.com' }));
    expect(url.origin + url.pathname).toBe('https://examplebucket.storage.googleapis.com/a/b.png');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request');
  });

  it('supports path style, http and ports (MinIO)', async () => {
    const url = new URL(await presignS3Get({ ...base, endpoint: 'http://minio.local:9000/', pathStyle: true }));
    expect(url.origin + url.pathname).toBe('http://minio.local:9000/examplebucket/a/b.png');
  });

  it('signs the host and path it returns', async () => {
    const virtual = new URL(await presignS3Get({ ...base, endpoint: 'minio.local' }));
    const path = new URL(await presignS3Get({ ...base, endpoint: 'minio.local', pathStyle: true }));
    expect(virtual.searchParams.get('X-Amz-Signature')).not.toBe(path.searchParams.get('X-Amz-Signature'));
  });

  it('normalizes endpoints and rejects anything but an origin', () => {
    expect(s3EndpointUrl(' storage.googleapis.com ')).toBe('https://storage.googleapis.com');
    expect(s3EndpointUrl('http://minio:9000/')).toBe('http://minio:9000');
    expect(() => s3EndpointUrl('ftp://minio')).toThrow(/Invalid S3 endpoint/);
    expect(() => s3EndpointUrl('https://minio/path')).toThrow(/Invalid S3 endpoint/);
    expect(() => s3EndpointUrl('https://user:pw@minio')).toThrow(/Invalid S3 endpoint/);
  });
});

describe('uriEncode', () => {
  it('keeps unreserved characters and encodes UTF-8 bytes', () => {
    expect(uriEncode('a-b_c.d~e/f g')).toBe('a-b_c.d~e%2Ff%20g');
    expect(uriEncode('å', true)).toBe('%C3%A5');
  });
});

describe('presigned PUT', () => {
  it('signs the method, so a GET link cannot upload', async () => {
    const { presignS3, presignS3Get } = await import('../src/sigv4.ts');
    const o = { bucket: 'b', region: 'auto', key: 'data/team-settings.json', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', now: new Date('2026-11-10T00:00:00Z') };
    const get = await presignS3Get(o);
    const put = await presignS3({ ...o, method: 'PUT' });
    expect(put.split('X-Amz-Signature=')[0]).toBe(get.split('X-Amz-Signature=')[0]);
    expect(put.split('X-Amz-Signature=')[1]).not.toBe(get.split('X-Amz-Signature=')[1]);
    expect(await presignS3(o)).toBe(get);
  });
});
