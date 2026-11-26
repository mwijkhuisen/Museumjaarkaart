import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { amzDate, canonicalQuery, canonicalUri, sha256Hex, sign, signingKey, uriEncode } from '../../src/lib/sigv4.ts';

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// The four "Examples: Signature Calculations" of the S3 developer guide, "Signature Calculations for the
// Authorization Header: Transferring Payload in a Single Chunk (AWS Signature Version 4)":
//   https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
// (fetched 2026-11-22; the old .../AmazonS3/latest/API/sig-v4-header-based-auth.html now redirects to
// the API index). Note the page's secret has `/bPx`, unlike the test suite's `+bPx` below.
const S3_CREDS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const S3_SCOPE = { region: 'us-east-1', service: 's3' };
const S3_DATE = new Date('2013-05-24T00:00:00Z');
const HOST = 'examplebucket.s3.amazonaws.com';
const sts = (hash: string) =>
  ['AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', hash].join('\n');
const authz = (signed: string, sig: string) =>
  `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=${signed},Signature=${sig}`;

describe('the S3 header-based examples', () => {
  it('GET Object with a Range', () => {
    // The request's own header values carry trailing spaces; the canonical form trims them.
    const s = sign(
      { method: 'GET', host: HOST, path: '/test.txt', headers: { Range: 'bytes=0-9 ' } },
      S3_CREDS,
      S3_SCOPE,
      S3_DATE,
    );
    expect(s.canonicalRequest).toBe(
      [
        'GET',
        '/test.txt',
        '',
        `host:${HOST}`,
        'range:bytes=0-9',
        `x-amz-content-sha256:${EMPTY}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY,
      ].join('\n'),
    );
    expect(s.stringToSign).toBe(sts('7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972'));
    expect(s.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(s.headers.authorization).toBe(
      authz(
        'host;range;x-amz-content-sha256;x-amz-date',
        'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
      ),
    );
    expect(s.headers).toEqual({
      range: 'bytes=0-9',
      'x-amz-date': '20130524T000000Z',
      'x-amz-content-sha256': EMPTY,
      authorization: s.headers.authorization,
    });
    expect(s.target).toBe('/test.txt');
  });

  it('PUT Object (test$file.text) with a body, Date and x-amz-storage-class', () => {
    const s = sign(
      {
        method: 'PUT',
        host: HOST,
        path: '/test$file.text',
        headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
        body: 'Welcome to Amazon S3.',
      },
      S3_CREDS,
      S3_SCOPE,
      S3_DATE,
    );
    const hash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';
    expect(s.canonicalRequest).toBe(
      [
        'PUT',
        '/test%24file.text',
        '',
        'date:Fri, 24 May 2013 00:00:00 GMT',
        `host:${HOST}`,
        `x-amz-content-sha256:${hash}`,
        'x-amz-date:20130524T000000Z',
        'x-amz-storage-class:REDUCED_REDUNDANCY',
        '',
        'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class',
        hash,
      ].join('\n'),
    );
    expect(s.stringToSign).toBe(sts('9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d'));
    expect(s.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    expect(s.headers.authorization).toBe(
      authz(
        'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class',
        '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
      ),
    );
    expect(s.headers['x-amz-content-sha256']).toBe(hash);
    expect(s.target).toBe('/test%24file.text');
  });

  it('GET Bucket Lifecycle (?lifecycle)', () => {
    const s = sign({ method: 'GET', host: HOST, path: '/', query: { lifecycle: '' } }, S3_CREDS, S3_SCOPE, S3_DATE);
    expect(s.canonicalRequest).toBe(
      [
        'GET',
        '/',
        'lifecycle=',
        `host:${HOST}`,
        `x-amz-content-sha256:${EMPTY}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;x-amz-content-sha256;x-amz-date',
        EMPTY,
      ].join('\n'),
    );
    expect(s.stringToSign).toBe(sts('9766c798316ff2757b517bc739a67f6213b4ab36dd5da2f94eaebf79c77395ca'));
    expect(s.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
    expect(s.headers.authorization).toBe(
      authz('host;x-amz-content-sha256;x-amz-date', 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543'),
    );
    expect(s.target).toBe('/?lifecycle=');
  });

  it('Get Bucket (List Objects) with ?max-keys=2&prefix=J, given out of order', () => {
    const s = sign(
      { method: 'GET', host: HOST, path: '/', query: { prefix: 'J', 'max-keys': '2' } },
      S3_CREDS,
      S3_SCOPE,
      S3_DATE,
    );
    expect(s.canonicalRequest).toBe(
      [
        'GET',
        '/',
        'max-keys=2&prefix=J',
        `host:${HOST}`,
        `x-amz-content-sha256:${EMPTY}`,
        'x-amz-date:20130524T000000Z',
        '',
        'host;x-amz-content-sha256;x-amz-date',
        EMPTY,
      ].join('\n'),
    );
    expect(s.stringToSign).toBe(sts('df57d21db20da04d7fa30298dd4488ba3a2b47ca3a489c74750e0f1e7df1b9b7'));
    expect(s.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
    expect(s.headers.authorization).toBe(
      authz('host;x-amz-content-sha256;x-amz-date', '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'),
    );
    expect(s.target).toBe('/?max-keys=2&prefix=J');
  });
});

// `get-vanilla` of AWS's Signature Version 4 test suite (aws-sig-v4-test-suite.zip, files
// get-vanilla/get-vanilla.{req,creq,sts,authz}), published at
//   https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html
// That page (and the zip under .../gr/samples/) was retired: on 2026-11-22 it redirects to the General
// Reference index, so these are the suite's published values, not a fresh fetch. A generic service
// ("service"), so no x-amz-content-sha256 header.
describe('get-vanilla (the SigV4 test suite)', () => {
  it('matches the canonical request, string to sign and Authorization header', () => {
    const s = sign(
      { method: 'GET', host: 'example.amazonaws.com', path: '/' },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      { region: 'us-east-1', service: 'service' },
      new Date('2015-08-30T12:36:00Z'),
    );
    expect(s.canonicalRequest).toBe(
      ['GET', '/', '', 'host:example.amazonaws.com', 'x-amz-date:20150830T123600Z', '', 'host;x-amz-date', EMPTY].join(
        '\n',
      ),
    );
    expect(s.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
        'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
      ].join('\n'),
    );
    expect(s.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request,SignedHeaders=host;x-amz-date,Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(s.headers).not.toHaveProperty('x-amz-content-sha256');
  });
});

describe('signingKey', () => {
  // "Examples of how to derive a signing key for Signature Version 4", formerly
  //   https://docs.aws.amazon.com/general/latest/gr/signature-v4-examples.html
  // (on 2026-11-22 it redirects to the IAM guide's reference_sigv-create-signed-request.html, which
  // describes the derivation without values; docs.aws.amazon.com's own search index still lists the
  // localised page with this kSigning).
  it('derives the documented kSigning (iam, 20120215)', () => {
    expect(signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam').toString('hex')).toBe(
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d',
    );
  });

  // The browser-based upload example of the S3 developer guide, whose string to sign is the base64 POST
  // policy and whose key is derived for s3 on 20151229 (fetched 2026-11-22):
  //   https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-post-example.html
  it('signs the S3 POST policy example', () => {
    const policy =
      'eyAiZXhwaXJhdGlvbiI6ICIyMDE1LTEyLTMwVDEyOjAwOjAwLjAwMFoiLA0KICAiY29uZGl0aW9ucyI6IFsNCiAgICB7ImJ1Y2tldCI6ICJzaWd2NGV4YW1wbGVidWNrZXQifSwNCiAgICBbInN0YXJ0cy13aXRoIiwgIiRrZXkiLCAidXNlci91c2VyMS8iXSwNCiAgICB7ImFjbCI6ICJwdWJsaWMtcmVhZCJ9LA0KICAgIHsic3VjY2Vzc19hY3Rpb25fcmVkaXJlY3QiOiAiaHR0cDovL3NpZ3Y0ZXhhbXBsZWJ1Y2tldC5zMy5hbWF6b25hd3MuY29tL3N1Y2Nlc3NmdWxfdXBsb2FkLmh0bWwifSwNCiAgICBbInN0YXJ0cy13aXRoIiwgIiRDb250ZW50LVR5cGUiLCAiaW1hZ2UvIl0sDQogICAgeyJ4LWFtei1tZXRhLXV1aWQiOiAiMTQzNjUxMjM2NTEyNzQifSwNCiAgICB7IngtYW16LXNlcnZlci1zaWRlLWVuY3J5cHRpb24iOiAiQUVTMjU2In0sDQogICAgWyJzdGFydHMtd2l0aCIsICIkeC1hbXotbWV0YS10YWciLCAiIl0sDQoNCiAgICB7IngtYW16LWNyZWRlbnRpYWwiOiAiQUtJQUlPU0ZPRE5ON0VYQU1QTEUvMjAxNTEyMjkvdXMtZWFzdC0xL3MzL2F3czRfcmVxdWVzdCJ9LA0KICAgIHsieC1hbXotYWxnb3JpdGhtIjogIkFXUzQtSE1BQy1TSEEyNTYifSwNCiAgICB7IngtYW16LWRhdGUiOiAiMjAxNTEyMjlUMDAwMDAwWiIgfQ0KICBdDQp9';
    const key = signingKey(S3_CREDS.secretAccessKey, '20151229', 'us-east-1', 's3');
    expect(createHmac('sha256', key).update(policy).digest('hex')).toBe(
      '8afdbf4008c03f22c2cd3cdb72e4afbb1f6a588f3255ac628749a66d7f09699e',
    );
  });
});

describe('encoding', () => {
  it.each([
    ['a b', 'a%20b'],
    ['a+b', 'a%2Bb'],
    ['~-._', '~-._'],
    ['AZaz09', 'AZaz09'],
    ['a/b', 'a%2Fb'],
    ["!'()*", '%21%27%28%29%2A'],
    ['=&?#', '%3D%26%3F%23'],
    ['%20', '%2520'],
    ['é', '%C3%A9'],
    ['€', '%E2%82%AC'],
    ['\u{1F600}', '%F0%9F%98%80'],
    ['', ''],
  ])('uriEncode(%j) is %j', (input, out) => {
    expect(uriEncode(input)).toBe(out);
  });

  it('refuses a lone surrogate', () => {
    expect(() => uriEncode('\u{D800}')).toThrow(URIError);
  });

  it('keeps / in a path, encodes each segment once and never normalises', () => {
    expect(canonicalUri('/bucket/a b/c+d/é~')).toBe('/bucket/a%20b/c%2Bd/%C3%A9~');
    expect(canonicalUri('/my-object//example//photo.user')).toBe('/my-object//example//photo.user');
    expect(canonicalUri('/a/./b/../c')).toBe('/a/./b/../c');
    expect(canonicalUri('')).toBe('/');
    expect(canonicalUri('/')).toBe('/');
  });

  it('sorts the query by the encoded name and keeps an empty value', () => {
    expect(canonicalQuery({ b: '', 'a~': '+', a: 'x y', A: '/' })).toBe('A=%2F&a=x%20y&a~=%2B&b=');
    // Raw `é` (U+00E9) sorts after `~`, encoded `%C3%A9` before it: the sort runs after encoding.
    expect(canonicalQuery({ 'a~': '1', aé: '2' })).toBe('a%C3%A9=2&a~=1');
    expect(canonicalQuery({ uploads: '' })).toBe('uploads=');
    expect(canonicalQuery({})).toBe('');
  });

  it('signs and sends the same encoded target', () => {
    const s = sign(
      { method: 'PUT', host: 'h', path: '/b/a b', query: { partNumber: '1', uploadId: 'x/y+z=' } },
      S3_CREDS,
      S3_SCOPE,
      S3_DATE,
    );
    expect(s.target).toBe('/b/a%20b?partNumber=1&uploadId=x%2Fy%2Bz%3D');
    expect(s.canonicalRequest.split('\n').slice(1, 3)).toEqual(['/b/a%20b', 'partNumber=1&uploadId=x%2Fy%2Bz%3D']);
  });
});

describe('sign', () => {
  it('lower-cases and trims header values, collapses inner whitespace, and owns host, date and Authorization', () => {
    const s = sign(
      {
        method: 'PUT',
        host: '127.0.0.1:9000',
        path: '/b/k',
        headers: {
          'Content-Type': '  text/plain  ',
          'Cache-Control': 'public,   max-age=60',
          Authorization: 'forged',
          Host: 'other.example',
          'X-Amz-Date': '19700101T000000Z',
        },
        body: new Uint8Array([1, 2, 3]),
      },
      S3_CREDS,
      S3_SCOPE,
      S3_DATE,
    );
    const lines = s.canonicalRequest.split('\n');
    expect(lines.slice(3, 8)).toEqual([
      'cache-control:public, max-age=60',
      'content-type:text/plain',
      'host:127.0.0.1:9000',
      `x-amz-content-sha256:${sha256Hex(new Uint8Array([1, 2, 3]))}`,
      'x-amz-date:20130524T000000Z',
    ]);
    expect(lines[9]).toBe('cache-control;content-type;host;x-amz-content-sha256;x-amz-date');
    expect(s.headers).not.toHaveProperty('host');
    expect(s.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\//);
    expect(s.headers['content-type']).toBe('text/plain');
  });

  it('hashes an absent body as the empty string', () => {
    expect(
      sign({ method: 'GET', host: 'h', path: '/' }, S3_CREDS, S3_SCOPE, S3_DATE).headers['x-amz-content-sha256'],
    ).toBe(EMPTY);
  });

  it('formats the date without separators or milliseconds', () => {
    expect(amzDate(new Date('2026-11-22T09:08:07.654Z'))).toBe('20261122T090807Z');
  });
});
